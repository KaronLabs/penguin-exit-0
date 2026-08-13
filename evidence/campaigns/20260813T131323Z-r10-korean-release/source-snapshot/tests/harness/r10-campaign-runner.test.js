import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as campaignLib from '../../scripts/r10-campaign-lib.mjs';
import * as campaignRunner from '../../scripts/run-r10-campaign.mjs';
import {
    assertR10RunId,
    claimRun,
    collectInventory,
    contentInventorySha256,
    copyInventory,
    inventoriesEqual,
    pathInventorySha256,
    runRecordedCommand,
    sha256Bytes,
    sha256File,
    validatePerformanceEvidence,
} from '../../scripts/r10-campaign-lib.mjs';
import { collectArtifactManifest, verifyR10Package } from '../../scripts/verify-r10-campaign.mjs';
import { archiveCommandEvidence, buildPhasePlan, persistNoGo, publishVerifiedOutputs, snapshotR9Frozen } from '../../scripts/run-r10-campaign.mjs';

function tempRoot(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'penguin-r10-lib-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function browserProgressLines() {
    const lines = [];
    for (let index = 1; index <= 48; index++) {
        const engine = index <= 16 ? 'chromium' : index <= 32 ? 'firefox' : 'webkit';
        lines.push(`[${index}/48] [${engine}] › test-${index}`);
    }
    lines.push('  48 passed (6.2s)');
    return lines.join('\n');
}

function legacyTapFooter(tests, durationMs) {
    return `1..${tests}\n# tests ${tests}\n# suites 0\n# pass ${tests}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms ${durationMs}\n`;
}

test('R10 run id is exact and duplicate ownership is refused from either original root', (t) => {
    const base = tempRoot(t);
    const operations = path.join(base, '.campaign-operations');
    const campaigns = path.join(base, 'evidence', 'campaigns');
    const runId = '20260807T123456Z-r10-korean-release';
    assert.equal(assertR10RunId(runId), runId);
    assert.throws(() => assertR10RunId('20260807T123456Z-r10-korean-release-again'));
    for (const invalid of [
        '20260230T123456Z-r10-korean-release',
        '20261301T123456Z-r10-korean-release',
        '20260807T240000Z-r10-korean-release',
        '20260807T126060Z-r10-korean-release',
    ]) assert.throws(() => assertR10RunId(invalid), /INVALID_RUN_ID/);

    const claim = claimRun({ operationsRoot: operations, campaignsRoot: campaigns, runId });
    assert.ok(fs.existsSync(claim.operationDir));
    assert.ok(fs.existsSync(path.join(claim.operationDir, 'start-receipt.json')));
    assert.throws(() => claimRun({ operationsRoot: operations, campaignsRoot: campaigns, runId }), /DUPLICATE_RUN_REFUSED/);

    const second = '20260807T123457Z-r10-korean-release';
    fs.mkdirSync(path.join(campaigns, second), { recursive: true });
    assert.throws(() => claimRun({ operationsRoot: operations, campaignsRoot: campaigns, runId: second }), /DUPLICATE_RUN_REFUSED/);
});

function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

function canonicalGitFixture(t) {
    const base = tempRoot(t);
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'R10 Harness');
    git(repo, 'config', 'user.email', 'r10@example.invalid');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'sealed\n');
    git(repo, 'add', 'tracked.txt');
    git(repo, 'commit', '-m', 'fixture');
    return { base, repo };
}

test('official campaign entry accepts only the clean canonical main checkout', (t) => {
    const { repo } = canonicalGitFixture(t);
    const binding = campaignLib.assertCanonicalCampaignSource(repo);
    assert.equal(binding.branch, 'main');
    assert.match(binding.headSha, /^[a-f0-9]{40}$/);

    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'no');
    assert.throws(() => campaignLib.assertCanonicalCampaignSource(repo), /dirty|untracked/i);
    fs.rmSync(path.join(repo, 'untracked.txt'));

    fs.appendFileSync(path.join(repo, 'tracked.txt'), 'changed\n');
    assert.throws(() => campaignLib.assertCanonicalCampaignSource(repo), /dirty|untracked/i);
    git(repo, 'restore', 'tracked.txt');

    git(repo, 'checkout', '-b', 'feature');
    assert.throws(() => campaignLib.assertCanonicalCampaignSource(repo), /main/i);
    git(repo, 'checkout', 'main');

    fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.js\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-m', 'ignore fixture secret');
    fs.writeFileSync(path.join(repo, 'secret.js'), 'ignored but candidate-visible');
    assert.equal(git(repo, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    assert.throws(() => campaignLib.assertCanonicalCampaignSource(repo), /tracked|candidate/i);
    fs.rmSync(path.join(repo, 'secret.js'));

    git(repo, 'update-index', '--skip-worktree', 'tracked.txt');
    fs.appendFileSync(path.join(repo, 'tracked.txt'), 'hidden working-tree mutation\n');
    assert.equal(git(repo, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    assert.throws(() => campaignLib.assertCanonicalCampaignSource(repo), /blob|bytes|size|HEAD/i);
    fs.rmSync(path.join(repo, 'tracked.txt'));
    assert.equal(git(repo, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    assert.throws(() => campaignLib.assertCanonicalCampaignSource(repo), /inventory|missing|HEAD/i);
});

test('linked worktrees and rejected sources create no official campaign ownership', (t) => {
    const { base, repo } = canonicalGitFixture(t);
    const linked = path.join(base, 'linked');
    git(repo, 'worktree', 'add', '--detach', linked, 'HEAD');
    assert.throws(() => campaignLib.assertCanonicalCampaignSource(linked), /worktree|canonical/i);

    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'no');
    const operationsRoot = path.join(repo, '.campaign-operations');
    const campaignsRoot = path.join(repo, 'evidence', 'campaigns');
    assert.throws(() => campaignRunner.beginOfficialCampaign({
        project: repo,
        workspace: base,
        operationsRoot,
        campaignsRoot,
        runId: '20260807T123456Z-r10-korean-release',
    }), /dirty|untracked/i);
    assert.equal(fs.existsSync(operationsRoot), false);
    assert.equal(fs.existsSync(campaignsRoot), false);
});

test('official entry refuses a missing prior R10 evidence set before ownership', (t) => {
    const { base, repo } = canonicalGitFixture(t);
    const operationsRoot = path.join(repo, '.campaign-operations');
    const campaignsRoot = path.join(repo, 'evidence', 'campaigns');
    assert.throws(() => campaignRunner.beginOfficialCampaign({
        project: repo,
        workspace: base,
        operationsRoot,
        campaignsRoot,
        runId: '20260807T123456Z-r10-korean-release',
    }), /R10.*missing/i);
    assert.equal(fs.existsSync(operationsRoot), false);
    assert.equal(fs.existsSync(campaignsRoot), false);
});

test('candidate inventory is ordered, excludes mutable evidence, and hashes NUL-delimited UTF-8 paths', (t) => {
    const root = tempRoot(t);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(root, 'evidence', 'campaigns'), { recursive: true });
    fs.mkdirSync(path.join(root, '.superpowers'), { recursive: true });
    fs.writeFileSync(path.join(root, 'z.txt'), 'z');
    fs.writeFileSync(path.join(root, 'src', '한글.txt'), 'penguin');
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'x.js'), 'excluded');
    fs.writeFileSync(path.join(root, 'evidence', 'campaigns', 'old.json'), 'excluded');
    fs.writeFileSync(path.join(root, '.superpowers', 'scratch'), 'excluded');

    const inventory = collectInventory(root);
    assert.deepEqual(inventory.files.map((entry) => entry.path), ['src/한글.txt', 'z.txt']);
    assert.equal(inventory.files[0].sizeBytes, Buffer.byteLength('penguin'));
    assert.match(inventory.files[0].sha256, /^[A-F0-9]{64}$/);
    const expected = crypto.createHash('sha256').update(Buffer.from('src/한글.txt\0z.txt\0', 'utf8')).digest('hex').toUpperCase();
    assert.equal(inventory.pathListSha256, expected);
    assert.equal(pathInventorySha256(inventory.files), expected);
});

test('clean-room copy must reproduce exact ordered paths, sizes, and hashes', (t) => {
    const base = tempRoot(t);
    const source = path.join(base, 'source');
    const copy = path.join(base, 'copy');
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(source, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(source, 'nested', 'b.txt'), 'beta');
    const expected = collectInventory(source);
    copyInventory(source, copy, expected.files);
    assert.equal(inventoriesEqual(expected, collectInventory(copy)), true);
    fs.appendFileSync(path.join(copy, 'a.txt'), '!');
    assert.equal(inventoriesEqual(expected, collectInventory(copy)), false);
});

test('performance verification recalculates raw percentiles and enforces duration-derived actions', () => {
    const frameDeltasMs = Array.from({ length: 10000 }, (_, index) => index < 9500 ? 16.7 : 16.8);
    const raw = {
        startedUtc: '2026-08-07T00:00:00.000Z',
        endedUtc: '2026-08-07T00:10:00.000Z',
        measuredDurationMs: 600000,
        sampleCount: frameDeltasMs.length,
        frameDeltasMs,
        longTaskObserverSupported: true,
        longTasksEntries: [],
    };
    const summary = {
        startedUtc: raw.startedUtc,
        endedUtc: raw.endedUtc,
        measuredDurationMs: 600000,
        sampleCount: frameDeltasMs.length,
        p95LatencyMs: 16.7,
        p99LatencyMs: 16.8,
        longTaskObserverSupported: true,
        longTasksCount: 0,
        heapNetGrowthMb: 1.2,
        heapStartMb: 10,
        heapEndMb: 11.2,
        totalActionsCount: 600,
    };
    const result = validatePerformanceEvidence(summary, raw, {});
    assert.equal(result.sampleCount, 10000);
    assert.equal(result.minimumActions, 600);
    assert.throws(() => validatePerformanceEvidence({ ...summary, totalActionsCount: 599 }, raw, {}), /action/i);
    assert.throws(() => validatePerformanceEvidence({ ...summary, p95LatencyMs: 0.1 }, raw, {}), /P95/i);
    assert.throws(() => validatePerformanceEvidence(summary, { ...raw, frameDeltasMs: raw.frameDeltasMs.slice(1) }, {}), /sample/i);
    const invalidTimestampSummary = { ...summary, startedUtc: 'not-a-timestamp', endedUtc: 'also-invalid' };
    const invalidTimestampRaw = { ...raw, startedUtc: 'not-a-timestamp', endedUtc: 'also-invalid' };
    assert.throws(() => validatePerformanceEvidence(invalidTimestampSummary, invalidTimestampRaw, {}), /timestamp/i);
    const durationMismatchEnd = '2026-08-07T00:10:02.000Z';
    assert.throws(() => validatePerformanceEvidence(
        { ...summary, endedUtc: durationMismatchEnd },
        { ...raw, endedUtc: durationMismatchEnd },
        {},
    ), /timestamp|duration/i);
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const frameDeltasMs = [...raw.frameDeltasMs];
        frameDeltasMs[500] = invalid;
        assert.throws(() => validatePerformanceEvidence(summary, { ...raw, frameDeltasMs }, {}), /delta|sample/i);
    }
    assert.throws(() => validatePerformanceEvidence({ ...summary, heapNetGrowthMb: 0.1 }, raw, {}), /heap/i);
    assert.throws(() => validatePerformanceEvidence({ ...summary, heapStartMb: Number.NaN }, raw, {}), /heap/i);
    assert.throws(() => validatePerformanceEvidence({ ...summary, longTaskObserverSupported: false }, raw, {}), /long-task|observer/i);
    assert.throws(() => validatePerformanceEvidence(summary, { ...raw, longTaskObserverSupported: false }, {}), /long-task|observer/i);
    assert.throws(() => validatePerformanceEvidence({ ...summary, heapStartMb: 0, heapEndMb: 1.2 }, raw, {}), /heap/i);
    assert.throws(() => validatePerformanceEvidence({ ...summary, heapStartMb: undefined }, raw, {}), /heap/i);
    assert.throws(() => validatePerformanceEvidence({ ...summary, heapEndMb: 0, heapNetGrowthMb: 0 }, raw, {}), /heap/i);
    assert.throws(() => validatePerformanceEvidence({ ...summary, heapEndMb: undefined }, raw, {}), /heap/i);
    assert.throws(() => validatePerformanceEvidence(summary, raw, { PERF_FAST: '1' }), /PERF_FAST/);
});

test('recorded commands persist argv, cwd, timestamps, timeout state, logs and hashes', (t) => {
    const root = tempRoot(t);
    const logs = path.join(root, 'logs');
    const receipt = runRecordedCommand({
        key: 'unit-fixture',
        argv: [process.execPath, '-e', "process.stdout.write('ok'); process.stderr.write('warn')"],
        cwd: root,
        logsDir: logs,
        timeoutMs: 10000,
    });
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.timedOut, false);
    assert.deepEqual(receipt.argv.slice(0, 2), [process.execPath, '-e']);
    assert.equal(receipt.cwd, root);
    assert.ok(Date.parse(receipt.startedUtc) <= Date.parse(receipt.endedUtc));
    assert.equal(fs.readFileSync(receipt.stdoutPath, 'utf8'), 'ok');
    assert.equal(fs.readFileSync(receipt.stderrPath, 'utf8'), 'warn');
    assert.match(receipt.stdoutSha256, /^[A-F0-9]{64}$/);
    assert.match(receipt.stderrSha256, /^[A-F0-9]{64}$/);
});

test('failure evidence is archived before NO_GO and remains verifiable after clean temp deletion', (t) => {
    const base = tempRoot(t);
    const clean = path.join(base, 'clean');
    const operation = path.join(base, 'operation');
    fs.mkdirSync(clean, { recursive: true });
    fs.mkdirSync(operation, { recursive: true });
    const command = runRecordedCommand({
        key: 'failed-phase',
        argv: [process.execPath, '-e', "process.stdout.write('partial'); process.stderr.write('boom'); process.exit(7)"],
        cwd: clean,
        logsDir: path.join(clean, 'logs'),
        timeoutMs: 10000,
    });
    const timeoutCommand = runRecordedCommand({
        key: 'timed-out-phase',
        argv: [process.execPath, '-e', 'setTimeout(() => {}, 1000)'],
        cwd: clean,
        logsDir: path.join(clean, 'logs'),
        timeoutMs: 20,
    });
    assert.equal(timeoutCommand.timedOut, true);
    const archived = persistNoGo({ operationDir: operation, runId: '20260807T123456Z-r10-korean-release', reason: 'fixture failure', commands: [command, timeoutCommand], cleanRoot: clean });
    assert.equal(archived[0].exitCode, 7);
    assert.equal(archived[1].timedOut, true);
    assert.ok(fs.existsSync(path.join(operation, 'NO_GO.json')));
    fs.rmSync(clean, { recursive: true, force: true });
    const durable = JSON.parse(fs.readFileSync(path.join(operation, 'commands', 'failed-phase.json')));
    assert.equal(fs.readFileSync(durable.stdoutPath, 'utf8'), 'partial');
    assert.equal(fs.readFileSync(durable.stderrPath, 'utf8'), 'boom');
    assert.equal(sha256File(durable.stdoutPath), durable.stdoutSha256);
    assert.equal(sha256File(durable.stderrPath), durable.stderrSha256);
    const durableTimeout = JSON.parse(fs.readFileSync(path.join(operation, 'commands', 'timed-out-phase.json')));
    assert.equal(durableTimeout.timedOut, true);
    assert.equal(sha256File(durableTimeout.stdoutPath), durableTimeout.stdoutSha256);
    assert.equal(sha256File(durableTimeout.stderrPath), durableTimeout.stderrSha256);

    fs.writeFileSync(path.join(base, 'different.log'), 'tampered');
    const conflicting = { ...command, stdoutPath: path.join(base, 'different.log'), stdoutSha256: sha256File(path.join(base, 'different.log')) };
    assert.throws(() => archiveCommandEvidence(operation, [conflicting]), /overwrite|mismatch/i);
});

test('performance collector clears warm-up data and establishes a fresh measurement boundary', () => {
    const source = fs.readFileSync(path.resolve('tests/browser/performance.spec.js'), 'utf8');
    const warmupWait = source.indexOf('await page.waitForTimeout(warmupMs)');
    const warmupClear = source.indexOf('window.__frameDeltas.length = 0', warmupWait);
    const startHeap = source.indexOf("const startMetrics = await cdp.send('Performance.getMetrics')");
    const measurementBoundary = source.indexOf('const startTime = await page.evaluate', startHeap);
    const boundaryClear = source.indexOf('window.__frameDeltas.length = 0', measurementBoundary);
    assert.ok(warmupWait >= 0 && warmupClear > warmupWait && startHeap > warmupClear);
    assert.ok(measurementBoundary > startHeap && boundaryClear > measurementBoundary);
    assert.match(source, /window\.__longTaskObserverSupported\s*=\s*false/);
    assert.match(source, /observer\.observe\([\s\S]*?window\.__longTaskObserverSupported\s*=\s*true/);
    assert.doesNotMatch(source, /JSHeapUsedSize'\)\?\.value\s*\|\|\s*0/);
});

test('R10 verifier binds exact source, payloads, ledger, command logs, raw performance and spec', (t) => {
    const base = tempRoot(t);
    const runId = '20260807T123456Z-r10-korean-release';
    const source = path.join(base, 'source');
    const execution = path.join(base, 'execution');
    const campaign = path.join(base, 'campaign');
    const spec = path.join(base, 'spec.md');
    fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
    fs.mkdirSync(execution, { recursive: true });
    fs.mkdirSync(path.join(campaign, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(source, 'game-core.js'), 'fixture-core');
    fs.writeFileSync(path.join(source, 'index.html'), '<main>펭귄</main>');
    const priorR10 = path.join(source, 'evidence', 'campaigns', '20260807T000000Z-r10-korean-release', 'claims.json');
    fs.mkdirSync(path.dirname(priorR10), { recursive: true });
    fs.writeFileSync(priorR10, '{}');
    git(source, 'init', '-b', 'main');
    git(source, 'config', 'user.name', 'R10 Harness');
    git(source, 'config', 'user.email', 'r10@example.invalid');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'authority fixture');
    const candidate = collectInventory(source);
    fs.writeFileSync(path.join(campaign, 'candidate-inventory.json'), JSON.stringify(candidate, null, 2));

    const phasePlan = buildPhasePlan(execution);
    const stdoutByKey = {
        '10-npm-ci': 'added 3 packages\n',
        '20-preflight': 'Preflight status: match=true\n',
        '30-unit': legacyTapFooter(29, '563.6752'),
        '40-browser': browserProgressLines(),
        '50-performance': '[PERF] Warming up for 30s...\n[PERF] Starting workload measurement loop for 600s...\n',
        '60-manifest': '[MANIFEST GENERATOR] Successfully generated manifest.json with 42 tracked files.\n',
        '61-evidence-gate': 'EVIDENCE_GATE=GO\n',
        '70-negative-controls': 'NEGATIVE CONTROLS SUITE R7: 21 / 21 PASSED.\n',
        '71-campaign-verifier-tests': legacyTapFooter(6, '521.0431'),
    };
    let cursor = Date.parse('2026-08-07T00:00:03.000Z');
    const commands = phasePlan.map((phase) => {
        const duration = phase.key === '50-performance' ? 631000 : 1000;
        const stdout = path.join(campaign, 'commands', `${phase.key}.stdout.log`);
        const stderr = path.join(campaign, 'commands', `${phase.key}.stderr.log`);
        fs.writeFileSync(stdout, stdoutByKey[phase.key]);
        fs.writeFileSync(stderr, '');
        const command = {
            key: phase.key, argv: phase.argv, cwd: execution,
            startedUtc: new Date(cursor).toISOString(), endedUtc: new Date(cursor + duration).toISOString(),
            timeoutMs: phase.timeoutMs, timedOut: false, exitCode: 0, signal: null,
            stdoutPath: stdout, stdoutArtifactPath: `commands/${phase.key}.stdout.log`, stdoutSha256: sha256File(stdout),
            stderrPath: stderr, stderrArtifactPath: `commands/${phase.key}.stderr.log`, stderrSha256: sha256File(stderr),
        };
        cursor += duration + 1000;
        return command;
    });
    const performanceCommand = commands.find((command) => command.key === '50-performance');
    const measurementStart = Date.parse(performanceCommand.startedUtc) + 30000;
    const deltas = Array.from({ length: 10000 }, (_, index) => index < 9500 ? 16.7 : 16.8);
    const raw = {
        startedUtc: new Date(measurementStart).toISOString(), endedUtc: new Date(measurementStart + 600000).toISOString(),
        measuredDurationMs: 600000, sampleCount: deltas.length, frameDeltasMs: deltas, longTasksEntries: [],
        longTaskObserverSupported: true,
    };
    const summary = {
        startedUtc: raw.startedUtc, endedUtc: raw.endedUtc, measuredDurationMs: 600000,
        sampleCount: deltas.length, p95LatencyMs: 16.7, p99LatencyMs: 16.8,
        longTaskObserverSupported: true, longTasksCount: 0, heapNetGrowthMb: 1,
        heapStartMb: 10, heapEndMb: 11,
        totalActionsCount: 600,
    };
    fs.writeFileSync(path.join(campaign, 'frame-samples.json'), JSON.stringify(raw));
    fs.writeFileSync(path.join(campaign, 'performance-summary.json'), JSON.stringify(summary));
    const states = [
        'CREATED', 'SOURCE_INVENTORY_PASS', 'CLEAN_COPY_PASS', 'NPM_CI_PASS', 'PREFLIGHT_PASS',
        'UNIT_PASS', 'BROWSER_PASS', 'PERFORMANCE_PASS', 'MANIFEST_PASS', 'EVIDENCE_GATE_PASS',
        'NEGATIVE_CONTROLS_PASS', 'CAMPAIGN_VERIFIER_TESTS_PASS', 'PACKAGE_READY_FOR_GATE',
    ];
    const ledger = states.map((state, index) => ({
        schemaVersion: 5, runId, state,
        timestampUtc: index < 3
            ? new Date(Date.parse('2026-08-07T00:00:00.000Z') + index * 1000).toISOString()
            : index <= 11 ? commands[index - 3].endedUtc : new Date(cursor + (index - 12) * 1000).toISOString(),
        command: index >= 3 && index <= 11 ? commands[index - 3] : null,
    }));
    fs.writeFileSync(path.join(campaign, 'ledger.jsonl'), `${ledger.map(JSON.stringify).join('\n')}\n`);
    const r9File = { path: 'evidence/campaigns/r9/claims.json', sizeBytes: 2, sha256: sha256Bytes('{}') };
    const r9Snapshot = {
        fileCount: 1,
        pathListSha256: pathInventorySha256([r9File]),
        digest: contentInventorySha256([r9File]),
        files: [r9File],
    };
    fs.writeFileSync(path.join(campaign, 'r9-before.json'), JSON.stringify(r9Snapshot, null, 2));
    fs.writeFileSync(path.join(campaign, 'r9-after.json'), JSON.stringify(r9Snapshot, null, 2));
    const r10Snapshot = campaignRunner.snapshotR10Frozen(source, base, runId);
    fs.writeFileSync(path.join(campaign, 'r10-before.json'), JSON.stringify(r10Snapshot, null, 2));
    fs.writeFileSync(path.join(campaign, 'r10-after.json'), JSON.stringify(r10Snapshot, null, 2));
    const claims = {
        schemaVersion: 5, runId,
        candidateInventory: { fileCount: candidate.fileCount, pathListSha256: candidate.pathListSha256, contentRecordsSha256: candidate.contentRecordsSha256 },
        gameCoreSha256: sha256File(path.join(source, 'game-core.js')),
        sourceGit: { branch: 'main', headSha: git(source, 'rev-parse', 'HEAD') },
        unit: { tests: 29, passed: 29, failed: 0, exitCode: 0 },
        browser: { chromium: { passed: 16, failed: 0 }, firefox: { passed: 16, failed: 0 }, webkit: { passed: 16, failed: 0 }, integrity: true, reportedFailures: 0, exitCode: 0 },
        performance: summary,
        negativeControls: { passed: 21, total: 21, failed: 0, exitCode: 0 },
        campaignVerifier: { tests: 6, passed: 6, failed: 0, exitCode: 0 },
        r9Frozen: { fileCount: 1, pathListSha256: r9Snapshot.pathListSha256, beforeDigest: r9Snapshot.digest, afterDigest: r9Snapshot.digest },
        r10Frozen: { fileCount: 1, pathListSha256: r10Snapshot.pathListSha256, beforeDigest: r10Snapshot.digest, afterDigest: r10Snapshot.digest },
        actualBrowserZoom: { claimed: false, equivalentReflow: '3-engine 640x360 equivalent PASS', limitation: 'actual browser chrome zoom not claimed' },
    };
    fs.writeFileSync(path.join(campaign, 'claims.json'), JSON.stringify(claims, null, 2));
    fs.writeFileSync(spec, `# R10\nrun=${runId}\npathDigest=${candidate.pathListSha256}\ncontentDigest=${candidate.contentRecordsSha256}\nhead=${claims.sourceGit.headSha}\nr10Digest=${r10Snapshot.digest}\nactual browser chrome zoom not claimed\n`);
    const manifest = collectArtifactManifest(campaign);
    fs.writeFileSync(path.join(campaign, 'artifact-manifest.json'), JSON.stringify(manifest, null, 2));
    const payloads = [
        'artifact-manifest.json', 'candidate-inventory.json', 'claims.json', 'ledger.jsonl',
        'r9-before.json', 'r9-after.json', 'r10-before.json', 'r10-after.json',
    ];
    const payloadHashes = Object.fromEntries(payloads.map((name) => [name, sha256File(path.join(campaign, name))]));
    fs.writeFileSync(path.join(campaign, 'submission-envelope.json'), JSON.stringify({
        schemaVersion: 5, runId, payloadHashes,
        source: {
            path: 'source-snapshot', fileCount: candidate.fileCount,
            pathListSha256: candidate.pathListSha256, contentRecordsSha256: candidate.contentRecordsSha256,
            gitBranch: 'main', gitHeadSha: claims.sourceGit.headSha,
        },
        spec: { fileName: `spec_${runId}_mission02_r10_korean_release.md`, sizeBytes: fs.statSync(spec).size, sha256: sha256File(spec) },
        rawEvidence: {
            summary: { path: 'performance-summary.json', sha256: sha256File(path.join(campaign, 'performance-summary.json')) },
            samples: { path: 'frame-samples.json', sha256: sha256File(path.join(campaign, 'frame-samples.json')) },
        },
    }, null, 2));

    const verificationArgs = {
        campaignDir: campaign, specPath: spec, sourceRoot: source, executionRoot: execution,
        expectedRunId: runId, expectedGameCoreSha256: claims.gameCoreSha256,
        authorityProjectRoot: source, authorityWorkspaceRoot: base,
    };
    assert.throws(() => verifyR10Package({
        campaignDir: campaign, specPath: spec, sourceRoot: source, executionRoot: execution,
        expectedRunId: runId, expectedGameCoreSha256: claims.gameCoreSha256,
    }), /authority/i);
    const verified = verifyR10Package(verificationArgs);
    assert.equal(verified.status, 'VERIFIED');

    const lateReviewReceipt = path.join(base, 'review', 'deployment_20260807_mission02_r10_late.md');
    fs.mkdirSync(path.dirname(lateReviewReceipt), { recursive: true });
    fs.writeFileSync(lateReviewReceipt, 'changed after package creation');
    assert.throws(() => verifyR10Package(verificationArgs), /authority.*R10|R10.*authority/i);
    fs.rmSync(lateReviewReceipt);

    const r10AfterPath = path.join(campaign, 'r10-after.json');
    fs.writeFileSync(r10AfterPath, JSON.stringify({ ...r10Snapshot, digest: sha256Bytes('forged') }, null, 2));
    fs.writeFileSync(path.join(campaign, 'artifact-manifest.json'), JSON.stringify(collectArtifactManifest(campaign), null, 2));
    let envelope = JSON.parse(fs.readFileSync(path.join(campaign, 'submission-envelope.json')));
    for (const name of payloads) envelope.payloadHashes[name] = sha256File(path.join(campaign, name));
    fs.writeFileSync(path.join(campaign, 'submission-envelope.json'), JSON.stringify(envelope, null, 2));
    assert.throws(() => verifyR10Package(verificationArgs), /R10.*snapshot|R10.*digest|R10.*differ/i);

    fs.writeFileSync(r10AfterPath, JSON.stringify(r10Snapshot, null, 2));
    fs.writeFileSync(path.join(campaign, 'artifact-manifest.json'), JSON.stringify(collectArtifactManifest(campaign), null, 2));
    envelope = JSON.parse(fs.readFileSync(path.join(campaign, 'submission-envelope.json')));
    for (const name of payloads) envelope.payloadHashes[name] = sha256File(path.join(campaign, name));
    fs.writeFileSync(path.join(campaign, 'submission-envelope.json'), JSON.stringify(envelope, null, 2));
    ledger[5].command.argv = [process.execPath, 'forged-success.mjs'];
    fs.writeFileSync(path.join(campaign, 'ledger.jsonl'), `${ledger.map(JSON.stringify).join('\n')}\n`);
    fs.writeFileSync(path.join(campaign, 'artifact-manifest.json'), JSON.stringify(collectArtifactManifest(campaign), null, 2));
    const envelopePath = path.join(campaign, 'submission-envelope.json');
    envelope = JSON.parse(fs.readFileSync(envelopePath));
    for (const name of payloads) envelope.payloadHashes[name] = sha256File(path.join(campaign, name));
    fs.writeFileSync(envelopePath, JSON.stringify(envelope, null, 2));
    assert.throws(() => verifyR10Package(verificationArgs), /argv|command/i);
    assert.throws(() => verifyR10Package({ campaignDir: campaign, specPath: spec, sourceRoot: source, executionRoot: execution, expectedRunId: 'not-r10', expectedGameCoreSha256: claims.gameCoreSha256 }), /run.id/i);
});

test('R10 phase plan runs every mutating tool only in clean source and never invokes test:all', (t) => {
    const base = tempRoot(t);
    const source = path.join(base, 'source');
    fs.mkdirSync(path.join(source, 'node_modules', '@playwright', 'test'), { recursive: true });
    const plan = buildPhasePlan(source);
    assert.deepEqual(plan.map((phase) => phase.key), [
        '10-npm-ci', '20-preflight', '30-unit', '40-browser', '50-performance',
        '60-manifest', '61-evidence-gate', '70-negative-controls', '71-campaign-verifier-tests',
    ]);
    assert.ok(plan.every((phase) => phase.cwd === source));
    assert.ok(plan.every((phase) => !phase.argv.join(' ').includes('test:all')));
    assert.ok(plan.every((phase) => !phase.argv.join(' ').includes('campaign:build')));
    assert.ok(plan.find((phase) => phase.key === '50-performance').timeoutMs >= 780000);

    const node24UnitTail = '✔ generic resolution never applies a hidden star penalty (0.1566ms)\nℹ tests 29\nℹ suites 0\nℹ pass 29\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 502.5497\n';
    const node24VerifierTail = '✔ rejects a report whose bound claims are stale (61.3721ms)\nℹ tests 6\nℹ suites 0\nℹ pass 6\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 445.6526\n';
    const legacyUnitTail = "  duration_ms: 0.3186\n  type: 'test'\n  ...\n1..29\n# tests 29\n# suites 0\n# pass 29\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 563.6752\n";
    const legacyVerifierTail = "  duration_ms: 70.3871\n  type: 'test'\n  ...\n1..6\n# tests 6\n# suites 0\n# pass 6\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 521.0431\n";
    for (const [summary, expected] of [
        [node24UnitTail, { tests: 29, passed: 29, failed: 0 }],
        [node24VerifierTail, { tests: 6, passed: 6, failed: 0 }],
        [legacyUnitTail, { tests: 29, passed: 29, failed: 0 }],
        [legacyVerifierTail, { tests: 6, passed: 6, failed: 0 }],
        [node24UnitTail.replaceAll('\n', '\r\n'), { tests: 29, passed: 29, failed: 0 }],
        [node24VerifierTail.slice(0, -1), { tests: 6, passed: 6, failed: 0 }],
        ['body\nℹ tests 2\nℹ suites 7\nℹ pass 2\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 0\n', { tests: 2, passed: 2, failed: 0 }],
    ]) assert.deepEqual(campaignLib.tapCounts(summary), expected);

    const nodeFooter = 'ℹ tests 29\nℹ suites 0\nℹ pass 29\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 502.5497\n';
    const invalidSummaries = {
        missing: '',
        tripletOnly: 'ℹ tests 29\nℹ pass 29\nℹ fail 0\n',
        missingField: nodeFooter.replace('ℹ cancelled 0\n', ''),
        reordered: nodeFooter.replace('ℹ suites 0\nℹ pass 29\n', 'ℹ pass 29\nℹ suites 0\n'),
        duplicated: nodeFooter.replace('ℹ suites 0\n', 'ℹ suites 0\nℹ suites 0\n'),
        mixedDialect: nodeFooter.replace('ℹ pass 29', '# pass 29'),
        mixedNewlines: nodeFooter.replace('ℹ suites 0\n', 'ℹ suites 0\r\n'),
        trailingJunk: `${nodeFooter}spoof\n`,
        trailingBlankLine: `${nodeFooter}\n`,
        trailingSpace: nodeFooter.replace('ℹ duration_ms 502.5497\n', 'ℹ duration_ms 502.5497 \n'),
        bodyMarker: `ℹ tests 29\nbody\n${nodeFooter}`,
        bodyPlan: `1..29\nbody\n${nodeFooter}`,
        planMismatch: `${legacyTapFooter(29, '563.6752').replace('1..29', '1..28')}`,
        planLeadingZero: legacyTapFooter(29, '563.6752').replace('1..29', '1..029'),
        testsLeadingZero: nodeFooter.replace('ℹ tests 29', 'ℹ tests 029'),
        testsSigned: nodeFooter.replace('ℹ tests 29', 'ℹ tests +29'),
        testsExponent: nodeFooter.replace('ℹ tests 29', 'ℹ tests 29e0'),
        testsUnicodeDigits: nodeFooter.replace('ℹ tests 29', 'ℹ tests ２９'),
        markerLookalike: nodeFooter.replace('ℹ tests 29', 'i tests 29'),
        unsafeTests: nodeFooter.replaceAll('29', '9007199254740992'),
        passMismatch: nodeFooter.replace('ℹ pass 29', 'ℹ pass 28'),
        failed: nodeFooter.replace('ℹ fail 0', 'ℹ fail 1'),
        cancelled: nodeFooter.replace('ℹ cancelled 0', 'ℹ cancelled 1'),
        skipped: nodeFooter.replace('ℹ skipped 0', 'ℹ skipped 1'),
        todo: nodeFooter.replace('ℹ todo 0', 'ℹ todo 1'),
        durationNegative: nodeFooter.replace('502.5497', '-1'),
        durationLeadingZero: nodeFooter.replace('502.5497', '0502.5497'),
        durationExponent: nodeFooter.replace('502.5497', '5e2'),
        durationInfinity: nodeFooter.replace('502.5497', '1e309'),
        durationMissingFraction: nodeFooter.replace('502.5497', '502.'),
        ansi: `\u001b[32m${nodeFooter}\u001b[0m`,
        nul: `body\u0000\n${nodeFooter}`,
        c1Csi: `body\u009b31m\n${nodeFooter}`,
        c1Osc: `body\u009dtitle\n${nodeFooter}`,
        c1St: `body\u009c\n${nodeFooter}`,
        tab: `body\ttext\n${nodeFooter}`,
    };
    for (const [name, summary] of Object.entries(invalidSummaries)) {
        assert.throws(() => campaignLib.tapCounts(summary), /TAP_COUNT_PROOF_MISSING/, name);
    }
});

test('R9 frozen snapshot is an ordered content digest over R9 campaign, operations and review receipts', (t) => {
    const base = tempRoot(t);
    const project = path.join(base, 'project');
    const workspace = base;
    fs.mkdirSync(path.join(project, 'evidence', 'campaigns', '20260807T000000Z-r9-final'), { recursive: true });
    fs.mkdirSync(path.join(project, '.campaign-operations'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'review'), { recursive: true });
    fs.writeFileSync(path.join(project, 'evidence', 'campaigns', '20260807T000000Z-r9-final', 'claims.json'), '{}');
    fs.writeFileSync(path.join(project, '.campaign-operations', '20260807T000000Z-r9-final.json'), '{}');
    fs.writeFileSync(path.join(workspace, 'review', 'deployment_20260807_mission02_r9_production.md'), 'sealed');
    fs.writeFileSync(path.join(workspace, 'review', 'unrelated.md'), 'ignored');
    const first = snapshotR9Frozen(project, workspace);
    assert.equal(first.fileCount, 3);
    assert.match(first.digest, /^[A-F0-9]{64}$/);
    fs.appendFileSync(path.join(workspace, 'review', 'unrelated.md'), '!');
    assert.deepEqual(snapshotR9Frozen(project, workspace), first);
});

test('pre-existing R10 snapshot binds campaigns, operations, review specs and deployment receipts', (t) => {
    const base = tempRoot(t);
    const project = path.join(base, 'project');
    const workspace = base;
    const campaignFile = path.join(project, 'evidence', 'campaigns', '20260807T000000Z-r10-korean-release', 'claims.json');
    const operationFile = path.join(project, '.campaign-operations', '20260807T000000Z-r10-korean-release', 'SUCCESS.json');
    const specFile = path.join(workspace, 'review', 'spec_20260807T000000Z-r10-korean-release_mission02_r10_korean_release.md');
    const receiptFile = path.join(workspace, 'review', 'deployment_20260807_mission02_r10_korean_release.md');
    for (const file of [campaignFile, operationFile, specFile, receiptFile]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, path.basename(file));
    }
    fs.writeFileSync(path.join(workspace, 'review', 'r11-unrelated.md'), 'ignored');

    const first = campaignRunner.snapshotR10Frozen(project, workspace, '20260807T123456Z-r10-korean-release');
    assert.equal(first.fileCount, 4);
    assert.match(first.pathListSha256, /^[A-F0-9]{64}$/);
    assert.match(first.digest, /^[A-F0-9]{64}$/);

    const disguisedCurrentId = path.join(
        path.dirname(campaignFile),
        'injected-20260807T123456Z-r10-korean-release.txt',
    );
    fs.writeFileSync(disguisedCurrentId, 'added under a prior campaign');
    assert.throws(() => campaignRunner.assertFrozenSnapshotUnchanged(
        first,
        campaignRunner.snapshotR10Frozen(project, workspace, '20260807T123456Z-r10-korean-release'),
        'R10',
    ), /R10.*CHANGED/i);
    fs.rmSync(disguisedCurrentId);

    const disguisedReviewSpec = path.join(
        workspace,
        'review',
        'spec_20260807T123456Z-r10-korean-release_injected.md',
    );
    fs.writeFileSync(disguisedReviewSpec, 'not the exact current spec');
    assert.throws(() => campaignRunner.assertFrozenSnapshotUnchanged(
        first,
        campaignRunner.snapshotR10Frozen(project, workspace, '20260807T123456Z-r10-korean-release'),
        'R10',
    ), /R10.*CHANGED/i);
    fs.rmSync(disguisedReviewSpec);

    const disguisedLegacyOperation = path.join(
        project,
        '.campaign-operations',
        '20260807T123456Z-r10-korean-release.json',
    );
    fs.writeFileSync(disguisedLegacyOperation, 'not created by the current runner');
    assert.throws(() => campaignRunner.assertFrozenSnapshotUnchanged(
        first,
        campaignRunner.snapshotR10Frozen(project, workspace, '20260807T123456Z-r10-korean-release'),
        'R10',
    ), /R10.*CHANGED/i);
    fs.rmSync(disguisedLegacyOperation);

    fs.appendFileSync(specFile, 'tampered');
    assert.throws(() => campaignRunner.assertFrozenSnapshotUnchanged(
        first,
        campaignRunner.snapshotR10Frozen(project, workspace, '20260807T123456Z-r10-korean-release'),
        'R10',
    ), /R10.*CHANGED/i);
    fs.writeFileSync(specFile, path.basename(specFile));

    fs.rmSync(operationFile);
    assert.throws(() => campaignRunner.assertFrozenSnapshotUnchanged(
        first,
        campaignRunner.snapshotR10Frozen(project, workspace, '20260807T123456Z-r10-korean-release'),
        'R10',
    ), /R10.*CHANGED/i);
    fs.writeFileSync(operationFile, path.basename(operationFile));

    const added = path.join(project, 'evidence', 'campaigns', '20260807T010000Z-r10-korean-release', 'claims.json');
    fs.mkdirSync(path.dirname(added), { recursive: true });
    fs.writeFileSync(added, 'added');
    assert.throws(() => campaignRunner.assertFrozenSnapshotUnchanged(
        first,
        campaignRunner.snapshotR10Frozen(project, workspace, '20260807T123456Z-r10-korean-release'),
        'R10',
    ), /R10.*CHANGED/i);
});

test('official entry snapshots prior R10 before claiming the current run and excludes only that run', (t) => {
    const { base, repo } = canonicalGitFixture(t);
    const priorCampaign = path.join(repo, 'evidence', 'campaigns', '20260807T000000Z-r10-korean-release', 'claims.json');
    fs.mkdirSync(path.dirname(priorCampaign), { recursive: true });
    fs.writeFileSync(priorCampaign, '{}');
    git(repo, 'add', '-f', 'evidence/campaigns/20260807T000000Z-r10-korean-release/claims.json');
    git(repo, 'commit', '-m', 'prior evidence');
    const runId = '20260807T123456Z-r10-korean-release';
    const operationsRoot = path.join(repo, '.campaign-operations');
    const campaignsRoot = path.join(repo, 'evidence', 'campaigns');
    const entry = campaignRunner.beginOfficialCampaign({
        project: repo,
        workspace: base,
        operationsRoot,
        campaignsRoot,
        runId,
    });
    assert.equal(entry.r10FrozenBefore.fileCount, 1);
    assert.ok(fs.existsSync(path.join(operationsRoot, runId, 'start-receipt.json')));
    assert.deepEqual(
        campaignRunner.snapshotR10Frozen(repo, base, runId),
        entry.r10FrozenBefore,
    );
});

test('the sealed real schema v3 R10 package remains verifiable under its historical 39/13 contract', (t) => {
    const project = path.resolve('.');
    const canonicalProject = path.dirname(path.resolve(project, git(project, 'rev-parse', '--git-common-dir')));
    const workspace = path.dirname(canonicalProject);
    const runId = '20260807T002345Z-r10-korean-release';
    const campaignDir = path.join(project, 'evidence', 'campaigns', runId);
    const specPath = path.join(workspace, 'review', `spec_${runId}_mission02_r10_korean_release.md`);
    const ledger = fs.readFileSync(path.join(campaignDir, 'ledger.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    const executionRoot = ledger.find((entry) => entry.command)?.command.cwd;
    const result = verifyR10Package({
        campaignDir,
        specPath,
        sourceRoot: path.join(campaignDir, 'source-snapshot'),
        executionRoot,
        expectedRunId: runId,
    });
    assert.equal(result.status, 'VERIFIED');

    function mutatedPackage({ mutateClaims = () => {}, mutateLedger = () => {}, mutateEnvelope = () => {}, expectedRunId = runId } = {}) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'penguin-r10-v3-mutation-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const copiedCampaign = path.join(root, 'campaign');
        const copiedSpec = path.join(root, path.basename(specPath));
        fs.cpSync(campaignDir, copiedCampaign, { recursive: true });
        fs.copyFileSync(specPath, copiedSpec);
        const claimsPath = path.join(copiedCampaign, 'claims.json');
        const copiedClaims = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
        mutateClaims(copiedClaims);
        fs.writeFileSync(claimsPath, JSON.stringify(copiedClaims, null, 2));
        const ledgerPath = path.join(copiedCampaign, 'ledger.jsonl');
        const copiedLedger = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
        mutateLedger(copiedLedger);
        fs.writeFileSync(ledgerPath, `${copiedLedger.map(JSON.stringify).join('\n')}\n`);
        const manifestPath = path.join(copiedCampaign, 'artifact-manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(collectArtifactManifest(copiedCampaign), null, 2));
        const envelopePath = path.join(copiedCampaign, 'submission-envelope.json');
        const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
        for (const name of Object.keys(envelope.payloadHashes)) {
            envelope.payloadHashes[name] = sha256File(path.join(copiedCampaign, name));
        }
        mutateEnvelope(envelope);
        fs.writeFileSync(envelopePath, JSON.stringify(envelope, null, 2));
        return {
            campaignDir: copiedCampaign,
            specPath: copiedSpec,
            sourceRoot: path.join(copiedCampaign, 'source-snapshot'),
            executionRoot,
            expectedRunId,
        };
    }

    const unknownRunId = '20260807T002346Z-r10-korean-release';
    const attacks = [
        { name: 'evil node launcher', options: { mutateLedger: (entries) => { entries.find((entry) => entry.command?.key === '20-preflight').command.argv[0] = 'C:\\evil\\node.exe'; } } },
        { name: 'relative node launcher', options: { mutateLedger: (entries) => { entries.find((entry) => entry.command?.key === '20-preflight').command.argv[0] = 'node'; } } },
        { name: 'evil cmd wrapper', options: { mutateLedger: (entries) => { entries.find((entry) => entry.command?.key === '10-npm-ci').command.argv[0] = 'C:\\evil\\cmd.exe'; } } },
        { name: 'external Playwright CLI root', options: { mutateLedger: (entries) => { entries.find((entry) => entry.command?.key === '40-browser').command.argv[1] = 'C:\\evil\\node_modules\\@playwright\\test\\cli.js'; } } },
        { name: 'Playwright CLI traversal root', options: { mutateLedger: (entries) => { entries.find((entry) => entry.command?.key === '40-browser').command.argv[1] = 'C:\\evil\\..\\external\\node_modules\\@playwright\\test\\cli.js'; } } },
        { name: 'forged script', options: { mutateLedger: (entries) => { const command = entries.find((entry) => entry.command?.key === '20-preflight').command; command.argv = [command.argv[0], 'scripts/forged-preflight.mjs']; } } },
        { name: 'foreign cwd', options: { mutateLedger: (entries) => { for (const entry of entries) if (entry.command) entry.command.cwd = 'C:\\forged\\other-source'; } } },
        { name: 'envelope byte mutation', options: { mutateEnvelope: (envelope) => { envelope.anchorProbe = 'forged'; } } },
        {
            name: 'unknown schema-v3 package',
            options: {
                expectedRunId: unknownRunId,
                mutateClaims: (claims) => { claims.runId = unknownRunId; },
                mutateLedger: (entries) => { for (const entry of entries) entry.runId = unknownRunId; },
                mutateEnvelope: (envelope) => { envelope.runId = unknownRunId; },
            },
        },
    ];
    const outcomes = attacks.map(({ options }) => {
        try {
            verifyR10Package(mutatedPackage(options));
            return 'VERIFIED';
        } catch (error) {
            return error.message;
        }
    });
    assert.deepEqual(outcomes, attacks.map(() => 'untrusted schema v3 package'));
});

test('official spec and campaign cannot be published before the staged package is VERIFIED', (t) => {
    const base = tempRoot(t);
    const stagedCampaign = path.join(base, 'staged-campaign');
    const stagedSpec = path.join(base, 'staged-spec.md');
    const stagedReceipt = path.join(base, 'staged-receipt.json');
    const finalCampaign = path.join(base, 'official', 'campaign');
    const finalSpec = path.join(base, 'review', 'spec.md');
    const finalReceipt = path.join(base, 'review', 'receipt.json');
    const commitMarker = path.join(base, 'operations', 'SUCCESS.json');
    fs.mkdirSync(stagedCampaign, { recursive: true });
    fs.writeFileSync(path.join(stagedCampaign, 'claims.json'), '{}');
    fs.writeFileSync(stagedSpec, '# spec');
    fs.writeFileSync(stagedReceipt, '{}');
    const args = {
        stagedCampaign, stagedSpec, stagedReceipt, finalCampaign, finalSpec, finalReceipt, commitMarker,
        commitValue: { status: 'VERIFIED' },
    };
    assert.throws(() => publishVerifiedOutputs({ ...args, verification: { status: 'NO_GO' } }), /VERIFIED/);
    assert.equal(fs.existsSync(finalCampaign), false);
    assert.equal(fs.existsSync(finalSpec), false);
    assert.equal(fs.existsSync(commitMarker), false);
    assert.throws(() => publishVerifiedOutputs({
        ...args,
        verification: { status: 'VERIFIED' },
        publicationGuard: () => { throw new Error('R10_FROZEN_EVIDENCE_CHANGED_AT_PUBLICATION'); },
    }), /R10_FROZEN_EVIDENCE_CHANGED_AT_PUBLICATION/);
    assert.equal(fs.existsSync(finalCampaign), false);
    assert.equal(fs.existsSync(finalSpec), false);
    assert.equal(fs.existsSync(commitMarker), false);
    let guardCalled = false;
    publishVerifiedOutputs({
        ...args,
        verification: { status: 'VERIFIED' },
        publicationGuard: () => { guardCalled = true; },
    });
    assert.equal(guardCalled, true);
    assert.equal(fs.existsSync(path.join(finalCampaign, 'claims.json')), true);
    assert.equal(fs.readFileSync(finalSpec, 'utf8'), '# spec');
    assert.equal(fs.readFileSync(finalReceipt, 'utf8'), '{}');
    assert.equal(JSON.parse(fs.readFileSync(commitMarker)).status, 'VERIFIED');
});
