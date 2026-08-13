import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const R10_RUN_ID_RE = /^\d{8}T\d{6}Z-r10-korean-release$/;
export const FROZEN_GAME_CORE_SHA256 = 'B3FAD87BD4EEE3C608E4E2944A3572DF272646534D95ADED3A1463EBE6D708A2';
export const EXCLUDED_TOP_LEVEL = new Set([
    '.agents',
    '.campaign-operations',
    '.git',
    '.superpowers',
    '.wrangler',
    'evidence',
    'node_modules',
    'playwright-report',
    'test-results',
]);
export const EXCLUDED_FILE_NAMES = new Set(['debug.log']);

export function sha256Bytes(value) {
    return crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
}

export function sha256File(file) {
    return sha256Bytes(fs.readFileSync(file));
}

export function assertR10RunId(runId) {
    const match = (runId ?? '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-r10-korean-release$/);
    if (!match) {
        throw new Error('INVALID_RUN_ID expected=YYYYMMDDTHHMMSSZ-r10-korean-release');
    }
    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
    const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
    const [year, month, day, hour, minute, second] = parts;
    const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (timestamp.getUTCFullYear() !== year
        || timestamp.getUTCMonth() !== month - 1
        || timestamp.getUTCDate() !== day
        || timestamp.getUTCHours() !== hour
        || timestamp.getUTCMinutes() !== minute
        || timestamp.getUTCSeconds() !== second) {
        throw new Error('INVALID_RUN_ID UTC calendar date/time is impossible');
    }
    return runId;
}

function gitOutput(projectRoot, args) {
    const result = spawnSync('git', ['-C', projectRoot, ...args], {
        encoding: 'utf8',
        windowsHide: true,
    });
    if (result.status !== 0) {
        throw new Error(`CANONICAL_SOURCE_GIT_ERROR args=${args.join(' ')} stderr=${(result.stderr ?? '').trim()}`);
    }
    return (result.stdout ?? '').trim();
}

function gitBlobSha1(bytes) {
    const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
    return crypto.createHash('sha1').update(header).update(bytes).digest('hex');
}

function headCandidateInventory(project) {
    const files = [];
    const records = gitOutput(project, ['ls-tree', '-r', '-l', '-z', 'HEAD']).split('\0').filter(Boolean);
    for (const record of records) {
        const separator = record.indexOf('\t');
        if (separator < 0) throw new Error('CANONICAL_HEAD_TREE_INVALID missing path separator');
        const [mode, type, objectId, sizeText] = record.slice(0, separator).split(/\s+/);
        const relative = record.slice(separator + 1);
        if (type !== 'blob' || !mode.startsWith('100')) continue;
        const segments = relative.split('/');
        if (EXCLUDED_TOP_LEVEL.has(segments[0]) || EXCLUDED_FILE_NAMES.has(segments.at(-1))) continue;
        const absolute = path.join(project, ...segments);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
            throw new Error(`CANONICAL_HEAD_CANDIDATE_MISSING path=${relative}`);
        }
        const bytes = fs.readFileSync(absolute);
        const expectedSize = Number(sizeText);
        const actualBlob = gitBlobSha1(bytes);
        if (bytes.length !== expectedSize || actualBlob !== objectId) {
            throw new Error(`CANONICAL_HEAD_BLOB_BYTES_MISMATCH path=${relative} expectedSize=${expectedSize} actualSize=${bytes.length}`);
        }
        files.push({ path: relative, sizeBytes: bytes.length, sha256: sha256Bytes(bytes) });
    }
    return files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

export function assertCanonicalCampaignSource(projectRoot) {
    const project = fs.realpathSync.native(path.resolve(projectRoot));
    const dotGit = path.join(project, '.git');
    if (!fs.existsSync(dotGit) || !fs.statSync(dotGit).isDirectory()) {
        throw new Error('CANONICAL_SOURCE_REQUIRED linked worktree sources are forbidden');
    }
    const topLevel = fs.realpathSync.native(path.resolve(gitOutput(project, ['rev-parse', '--show-toplevel'])));
    const samePath = process.platform === 'win32'
        ? topLevel.toLowerCase() === project.toLowerCase()
        : topLevel === project;
    if (!samePath) throw new Error(`CANONICAL_SOURCE_REQUIRED project=${project} topLevel=${topLevel}`);
    const branch = gitOutput(project, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch !== 'main') throw new Error(`CANONICAL_MAIN_REQUIRED branch=${branch || 'detached'}`);
    const status = gitOutput(project, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (status !== '') throw new Error('CANONICAL_SOURCE_DIRTY tracked or untracked changes present');
    const candidate = collectInventory(project);
    const headFiles = headCandidateInventory(project);
    if (candidate.files.length !== headFiles.length
        || !candidate.files.every((entry, index) => {
            const head = headFiles[index];
            return head && entry.path === head.path && entry.sizeBytes === head.sizeBytes && entry.sha256 === head.sha256;
        })) throw new Error('CANONICAL_CANDIDATE_INVENTORY_DOES_NOT_MATCH_HEAD');
    const headSha = gitOutput(project, ['rev-parse', '--verify', 'HEAD']);
    if (!/^[a-f0-9]{40}$/.test(headSha)) throw new Error(`CANONICAL_HEAD_INVALID value=${headSha}`);
    return { projectRoot: project, branch, headSha };
}

export function writeJsonExclusive(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export function writeJsonAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, file);
}

export function claimRun({ operationsRoot, campaignsRoot, runId }) {
    assertR10RunId(runId);
    const operationDir = path.join(operationsRoot, runId);
    const legacyReceipt = path.join(operationsRoot, `${runId}.json`);
    const campaignDir = path.join(campaignsRoot, runId);
    if (fs.existsSync(operationDir) || fs.existsSync(legacyReceipt) || fs.existsSync(campaignDir)) {
        throw new Error(`DUPLICATE_RUN_REFUSED run=${runId}`);
    }
    fs.mkdirSync(operationsRoot, { recursive: true });
    fs.mkdirSync(campaignsRoot, { recursive: true });
    fs.mkdirSync(operationDir, { recursive: false });
    const receipt = {
        schemaVersion: 1,
        runId,
        state: 'STARTED',
        createdUtc: new Date().toISOString(),
        operationDir,
        campaignDir,
    };
    writeJsonExclusive(path.join(operationDir, 'start-receipt.json'), receipt);
    return { operationDir, campaignDir, receipt };
}

function normalizedRelativePath(root, file) {
    return path.relative(root, file).split(path.sep).join('/');
}

export function pathInventorySha256(files) {
    const records = files.map((entry) => `${entry.path}\0`).join('');
    return sha256Bytes(Buffer.from(records, 'utf8'));
}

export function contentInventorySha256(files) {
    const records = files.map((entry) => `${entry.path}\0${entry.sizeBytes}\0${entry.sha256}\0`).join('');
    return sha256Bytes(Buffer.from(records, 'utf8'));
}

function walkFrozenFiles(root, prefix, predicate, output) {
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const absolute = path.join(root, entry.name);
        const relative = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walkFrozenFiles(absolute, relative, predicate, output);
        else if (entry.isFile() && predicate(relative)) {
            const stat = fs.statSync(absolute);
            output.push({ path: relative, sizeBytes: stat.size, sha256: sha256File(absolute) });
        }
    }
}

export function snapshotR10Frozen(project, workspace, excludedRunId) {
    const files = [];
    const isCurrentRunRoot = (name, prefix) => excludedRunId && (
        name.startsWith(`${prefix}/${excludedRunId}/`)
    );
    walkFrozenFiles(path.join(project, 'evidence', 'campaigns'), 'evidence/campaigns', (name) => (
        /-r10-/i.test(name) && !isCurrentRunRoot(name, 'evidence/campaigns')
    ), files);
    walkFrozenFiles(path.join(project, '.campaign-operations'), '.campaign-operations', (name) => (
        /-r10-/i.test(name) && !isCurrentRunRoot(name, '.campaign-operations')
    ), files);
    walkFrozenFiles(path.join(workspace, 'review'), 'workspace-review', (name) => (
        /r10/i.test(name)
        && /(?:spec|receipt|deployment)[-_]/i.test(path.basename(name))
        && !(excludedRunId && (
            path.basename(name) === `spec_${excludedRunId}_mission02_r10_korean_release.md`
            || path.basename(name) === `receipt_${excludedRunId}_campaign.json`
        ))
    ), files);
    files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    return {
        fileCount: files.length,
        pathListSha256: pathInventorySha256(files),
        digest: contentInventorySha256(files),
        files,
    };
}

export function assertFrozenSnapshotUnchanged(before, after, label) {
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`${label}_FROZEN_EVIDENCE_CHANGED`);
}

export function collectInventory(root, options = {}) {
    const excludedTopLevel = options.excludedTopLevel ?? EXCLUDED_TOP_LEVEL;
    const excludedFileNames = options.excludedFileNames ?? EXCLUDED_FILE_NAMES;
    const files = [];

    function walk(directory, depth) {
        const entries = fs.readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name, 'en'));
        for (const entry of entries) {
            if (depth === 0 && excludedTopLevel.has(entry.name)) continue;
            if (entry.isFile() && excludedFileNames.has(entry.name)) continue;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(absolute, depth + 1);
            } else if (entry.isFile()) {
                const stat = fs.statSync(absolute);
                files.push({
                    path: normalizedRelativePath(root, absolute),
                    sizeBytes: stat.size,
                    sha256: sha256File(absolute),
                });
            }
        }
    }

    walk(root, 0);
    files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    return {
        schemaVersion: 1,
        algorithm: 'SHA-256',
        pathEncoding: 'UTF-8 NUL-terminated ordered path records',
        fileCount: files.length,
        pathListSha256: pathInventorySha256(files),
        contentRecordsSha256: contentInventorySha256(files),
        files,
    };
}

export function inventoriesEqual(expected, actual) {
    if (expected.fileCount !== actual.fileCount
        || expected.pathListSha256 !== actual.pathListSha256
        || expected.contentRecordsSha256 !== actual.contentRecordsSha256) return false;
    return expected.files.every((entry, index) => {
        const other = actual.files[index];
        return other && entry.path === other.path && entry.sizeBytes === other.sizeBytes && entry.sha256 === other.sha256;
    });
}

export function copyInventory(sourceRoot, targetRoot, files) {
    if (fs.existsSync(targetRoot)) throw new Error(`COPY_TARGET_EXISTS path=${targetRoot}`);
    fs.mkdirSync(targetRoot, { recursive: false });
    for (const entry of files) {
        const source = path.join(sourceRoot, ...entry.path.split('/'));
        const target = path.join(targetRoot, ...entry.path.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    }
}

export function runRecordedCommand({ key, argv, cwd, logsDir, timeoutMs, env = process.env }) {
    if (!Array.isArray(argv) || argv.length === 0) throw new Error('argv must be a non-empty array');
    fs.mkdirSync(logsDir, { recursive: true });
    const startedUtc = new Date().toISOString();
    const result = spawnSync(argv[0], argv.slice(1), {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        env,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
    });
    const endedUtc = new Date().toISOString();
    const stdout = result.stdout ?? '';
    const errorText = result.error ? `${result.error.stack ?? result.error.message}\n` : '';
    const stderr = `${result.stderr ?? ''}${errorText}`;
    const stdoutPath = path.join(logsDir, `${key}.stdout.log`);
    const stderrPath = path.join(logsDir, `${key}.stderr.log`);
    fs.writeFileSync(stdoutPath, stdout, 'utf8');
    fs.writeFileSync(stderrPath, stderr, 'utf8');
    const timedOut = result.error?.code === 'ETIMEDOUT';
    return {
        key,
        argv,
        cwd: path.resolve(cwd),
        startedUtc,
        endedUtc,
        timeoutMs,
        timedOut,
        exitCode: result.status ?? (timedOut ? 124 : 2),
        signal: result.signal ?? null,
        stdoutPath: path.resolve(stdoutPath),
        stdoutSha256: sha256File(stdoutPath),
        stderrPath: path.resolve(stderrPath),
        stderrSha256: sha256File(stderrPath),
    };
}

function npmCiArgv() {
    if (process.platform === 'win32') {
        return [process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c', 'npm', 'ci'];
    }
    return ['npm', 'ci'];
}

export function buildR10PhasePlan(cleanSource) {
    const playwrightCli = path.join(cleanSource, 'node_modules', '@playwright', 'test', 'cli.js');
    return [
        { key: '10-npm-ci', state: 'NPM_CI_PASS', argv: npmCiArgv(), cwd: cleanSource, timeoutMs: 300000 },
        { key: '20-preflight', state: 'PREFLIGHT_PASS', argv: [process.execPath, 'scripts/preflight.mjs'], cwd: cleanSource, timeoutMs: 30000 },
        { key: '30-unit', state: 'UNIT_PASS', argv: [process.execPath, '--test', 'tests/*.test.js'], cwd: cleanSource, timeoutMs: 120000 },
        {
            key: '40-browser', state: 'BROWSER_PASS', cwd: cleanSource, timeoutMs: 360000,
            argv: [process.execPath, playwrightCli, 'test', '--project=chromium', '--project=firefox', '--project=webkit', '--workers=1', '--reporter=line'],
        },
        {
            key: '50-performance', state: 'PERFORMANCE_PASS', cwd: cleanSource, timeoutMs: 900000,
            argv: [process.execPath, playwrightCli, 'test', 'tests/browser/performance.spec.js', '--project=chromium-perf', '--workers=1', '--reporter=line'],
        },
        { key: '60-manifest', state: 'MANIFEST_PASS', argv: [process.execPath, 'scripts/generate-manifest.mjs'], cwd: cleanSource, timeoutMs: 60000 },
        { key: '61-evidence-gate', state: 'EVIDENCE_GATE_PASS', argv: [process.execPath, 'scripts/verify-evidence.mjs'], cwd: cleanSource, timeoutMs: 120000 },
        { key: '70-negative-controls', state: 'NEGATIVE_CONTROLS_PASS', argv: [process.execPath, 'scripts/run-negative-controls.mjs'], cwd: cleanSource, timeoutMs: 360000 },
        { key: '71-campaign-verifier-tests', state: 'CAMPAIGN_VERIFIER_TESTS_PASS', argv: [process.execPath, '--test', 'tests/campaign-verifier.test.js'], cwd: cleanSource, timeoutMs: 120000 },
    ];
}

export function tapCounts(text) {
    const missing = () => { throw new Error('TAP_COUNT_PROOF_MISSING'); };
    if (typeof text !== 'string' || /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)
        || /\r(?!\n)/u.test(text)) missing();
    const hasCrlf = text.includes('\r\n');
    if (hasCrlf && text.replaceAll('\r\n', '').includes('\n')) missing();
    const normalized = hasCrlf ? text.replaceAll('\r\n', '\n') : text;
    const input = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
    if (input.endsWith('\n')) missing();
    const count = '(0|[1-9][0-9]*)';
    const duration = '((?:0|[1-9][0-9]*)(?:\\.[0-9]+)?)';
    const labels = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
    const nodeLines = labels.map((label) => `ℹ ${label} ${count}`).join('\\n');
    const legacyLines = labels.map((label) => `# ${label} ${count}`).join('\\n');
    const nodeMatch = input.match(new RegExp(`(^|\\n)${nodeLines}\\nℹ duration_ms ${duration}$`, 'u'));
    const legacyMatch = input.match(new RegExp(`(^|\\n)1\\.\\.${count}\\n${legacyLines}\\n# duration_ms ${duration}$`, 'u'));
    const matches = [nodeMatch, legacyMatch].filter(Boolean);
    if (matches.length !== 1) missing();
    const match = matches[0];
    const body = input.slice(0, match.index);
    if (/(?:^|\n)(?:ℹ (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b|# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b|1\.\.)/u.test(body)) missing();
    const offset = legacyMatch ? 3 : 2;
    const values = match.slice(offset, offset + 7).map(Number);
    const [tests, suites, passed, failed, cancelled, skipped, todo] = values;
    const durationMs = Number(match[offset + 7]);
    if (!values.every(Number.isSafeInteger) || !Number.isFinite(durationMs) || durationMs < 0
        || tests < 1 || suites < 0 || passed !== tests
        || failed !== 0 || cancelled !== 0 || skipped !== 0 || todo !== 0
        || (legacyMatch && Number(match[2]) !== tests)) missing();
    const result = { tests, passed, failed };
    return result;
}

function percentile(values, ratio) {
    if (values.length === 0) throw new Error('PERFORMANCE raw samples are empty');
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

export function validatePerformanceEvidence(summary, raw, env = process.env) {
    if (env.PERF_FAST !== undefined) throw new Error('PERF_FAST bypass is forbidden');
    if (!Array.isArray(raw?.frameDeltasMs)) throw new Error('PERFORMANCE raw frame sample array missing');
    const rawStartedMs = Date.parse(raw.startedUtc);
    const rawEndedMs = Date.parse(raw.endedUtc);
    if (!Number.isFinite(rawStartedMs) || !Number.isFinite(rawEndedMs) || rawEndedMs < rawStartedMs) {
        throw new Error('PERFORMANCE raw timestamps are invalid');
    }
    if (summary.startedUtc !== raw.startedUtc || summary.endedUtc !== raw.endedUtc) {
        throw new Error('PERFORMANCE raw/summary timestamps mismatch');
    }
    if (!Number.isFinite(summary.measuredDurationMs) || !Number.isFinite(raw.measuredDurationMs)
        || summary.measuredDurationMs !== raw.measuredDurationMs || summary.measuredDurationMs < 600000) {
        throw new Error('PERFORMANCE measured duration below 600000ms or mismatched');
    }
    const timestampDurationMs = rawEndedMs - rawStartedMs;
    if (!Number.isFinite(timestampDurationMs) || Math.abs(timestampDurationMs - raw.measuredDurationMs) > 1000) {
        throw new Error('PERFORMANCE raw timestamp duration does not match measured duration');
    }
    if (!Number.isInteger(summary.sampleCount) || !Number.isInteger(raw.sampleCount)
        || summary.sampleCount !== raw.sampleCount || summary.sampleCount !== raw.frameDeltasMs.length || summary.sampleCount < 10000) {
        throw new Error('PERFORMANCE sample count mismatch or below 10000');
    }
    if (!raw.frameDeltasMs.every((delta) => Number.isFinite(delta) && delta > 0)) {
        throw new Error('PERFORMANCE raw frame delta must be finite and greater than zero');
    }
    const p95LatencyMs = percentile(raw.frameDeltasMs, 0.95);
    const p99LatencyMs = percentile(raw.frameDeltasMs, 0.99);
    if (!Number.isFinite(summary.p95LatencyMs) || Math.abs(summary.p95LatencyMs - p95LatencyMs) > 0.1 || p95LatencyMs > 20.0) {
        throw new Error(`PERFORMANCE P95 invalid raw=${p95LatencyMs} summary=${summary.p95LatencyMs}`);
    }
    if (!Number.isFinite(summary.p99LatencyMs) || Math.abs(summary.p99LatencyMs - p99LatencyMs) > 0.1 || p99LatencyMs > 33.3) {
        throw new Error(`PERFORMANCE P99 invalid raw=${p99LatencyMs} summary=${summary.p99LatencyMs}`);
    }
    if (summary.longTaskObserverSupported !== true
        || raw.longTaskObserverSupported !== true
        || summary.longTasksCount !== 0
        || !Array.isArray(raw.longTasksEntries)
        || raw.longTasksEntries.length !== 0) {
        throw new Error('PERFORMANCE long-task evidence invalid');
    }
    if (!Number.isFinite(summary.heapStartMb) || !Number.isFinite(summary.heapEndMb)
        || !Number.isFinite(summary.heapNetGrowthMb) || summary.heapStartMb <= 0 || summary.heapEndMb <= 0
        || summary.heapNetGrowthMb < 0 || summary.heapNetGrowthMb > 5.0) {
        throw new Error('PERFORMANCE heap net growth invalid');
    }
    const calculatedHeapNetGrowthMb = Math.max(0, summary.heapEndMb - summary.heapStartMb);
    if (Math.abs(summary.heapNetGrowthMb - calculatedHeapNetGrowthMb) > 0.000001) {
        throw new Error(`PERFORMANCE heap net growth mismatch calculated=${calculatedHeapNetGrowthMb} summary=${summary.heapNetGrowthMb}`);
    }
    const minimumActions = Math.floor(summary.measuredDurationMs / 1000);
    if (!Number.isInteger(summary.totalActionsCount) || summary.totalActionsCount < minimumActions) {
        throw new Error(`PERFORMANCE action count below duration-derived minimum ${minimumActions}`);
    }
    return {
        measuredDurationMs: summary.measuredDurationMs,
        sampleCount: summary.sampleCount,
        p95LatencyMs,
        p99LatencyMs,
        longTaskObserverSupported: true,
        longTasksCount: 0,
        heapNetGrowthMb: summary.heapNetGrowthMb,
        totalActionsCount: summary.totalActionsCount,
        minimumActions,
        startedUtc: summary.startedUtc,
        endedUtc: summary.endedUtc,
    };
}

export function copyDirectoryExclusive(source, target) {
    if (fs.existsSync(target)) throw new Error(`PUBLISH_TARGET_EXISTS path=${target}`);
    fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
}

export function publishDirectoryAtomically(source, target) {
    if (fs.existsSync(target)) throw new Error(`PUBLISH_TARGET_EXISTS path=${target}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.publishing-${process.pid}`);
    if (fs.existsSync(temporary)) throw new Error(`PUBLISH_TEMP_EXISTS path=${temporary}`);
    try {
        copyDirectoryExclusive(source, temporary);
        fs.renameSync(temporary, target);
    } catch (error) {
        if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
        throw error;
    }
}
