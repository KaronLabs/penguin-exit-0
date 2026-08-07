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
    if (!R10_RUN_ID_RE.test(runId ?? '')) {
        throw new Error('INVALID_RUN_ID expected=YYYYMMDDTHHMMSSZ-r10-korean-release');
    }
    return runId;
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
    const read = (label) => Number(text.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))?.[1]);
    const result = { tests: read('tests'), passed: read('pass'), failed: read('fail') };
    if (!Object.values(result).every(Number.isFinite)) throw new Error('TAP_COUNT_PROOF_MISSING');
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
