import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserCountsAreComplete, parsePassingBrowserCounts } from './campaign-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(root, '..');
const runIndex = process.argv.indexOf('--run');
const runId = runIndex >= 0 ? process.argv[runIndex + 1] : null;
if (!runId || !/^\d{8}T\d{6}Z-r9-[a-z0-9-]+$/.test(runId)) {
    console.error('Usage: node scripts/run-r9-campaign.mjs --run YYYYMMDDTHHMMSSZ-r9-name');
    process.exit(2);
}

const campaign = path.join(root, 'evidence', 'campaigns', runId);
const operations = path.join(root, '.campaign-operations');
const receipt = path.join(operations, `${runId}.json`);
if (fs.existsSync(receipt) || fs.existsSync(campaign)) {
    console.error(`DUPLICATE_RUN_REFUSED run=${runId}`);
    process.exit(1);
}
fs.mkdirSync(operations, { recursive: true });
fs.writeFileSync(receipt, JSON.stringify({ runId, createdUtc: new Date().toISOString(), campaign }, null, 2), { flag: 'wx' });
fs.mkdirSync(campaign, { recursive: false });

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function run(key, argv, timeoutMs) {
    const startedUtc = new Date().toISOString();
    const result = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8', timeout: timeoutMs, env: process.env });
    const endedUtc = new Date().toISOString();
    const stdout = result.stdout ?? '';
    const stderr = `${result.stderr ?? ''}${result.error ? `\n${result.error.stack ?? result.error.message}` : ''}`;
    const stdoutPath = path.join(campaign, `${key}.stdout.log`);
    const stderrPath = path.join(campaign, `${key}.stderr.log`);
    fs.writeFileSync(stdoutPath, stdout);
    fs.writeFileSync(stderrPath, stderr);
    const exitCode = result.status ?? (result.error ? 2 : 1);
    const command = {
        argv, cwd: root, startedUtc, endedUtc, exitCode,
        stdoutPath, stdoutSha256: sha256(stdoutPath), stderrPath, stderrSha256: sha256(stderrPath),
    };
    if (exitCode !== 0) {
        fs.writeFileSync(path.join(campaign, 'NO_GO.json'), JSON.stringify({ key, command }, null, 2));
        console.error(`NO_GO phase=${key} exit=${exitCode}`);
        process.exit(1);
    }
    return { command, stdout, stderr };
}

function tapCounts(text) {
    const read = (name) => Number(text.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1]);
    return { tests: read('tests'), passed: read('pass'), failed: read('fail') };
}

const createdUtc = new Date().toISOString();
const preflight = run('00-preflight', [process.execPath, 'scripts/preflight.mjs'], 30000);
const playwrightCli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const unit = run('10-unit', [process.execPath, '--test', 'tests/*.test.js'], 120000);
const browser = run('20-browser', [process.execPath, playwrightCli, 'test', '--project=chromium', '--project=firefox', '--project=webkit', '--workers=1', '--reporter=line'], 300000);
const performance = run('30-performance', [process.execPath, playwrightCli, 'test', 'tests/browser/performance.spec.js', '--project=chromium-perf', '--workers=1', '--reporter=line'], 720000);
const evidenceNegative = run('40-negative-evidence', [process.execPath, 'scripts/run-negative-controls.mjs'], 300000);
const campaignNegative = run('41-negative-campaign', [process.execPath, '--test', 'tests/campaign-verifier.test.js'], 120000);

const perfSummaryPath = path.join(root, 'evidence', 'performance', 'performance-summary.json');
const perfSamplesPath = path.join(root, 'evidence', 'performance', 'frame-samples.json');
const perf = JSON.parse(fs.readFileSync(perfSummaryPath));
const unitResult = tapCounts(unit.stdout);
const browserResult = parsePassingBrowserCounts(browser.stdout, browser.command.exitCode);
if (!browserCountsAreComplete(browserResult)) {
    fs.writeFileSync(path.join(campaign, 'NO_GO.json'), JSON.stringify({ reason: 'browser count proof incomplete', browserResult }, null, 2));
    console.error(`NO_GO browser counts=${JSON.stringify(browserResult)}`);
    process.exit(1);
}
const campaignResult = tapCounts(campaignNegative.stdout);
const evidencePassed = Number(evidenceNegative.stdout.match(/NEGATIVE CONTROLS SUITE R7: (\d+) \/ (\d+) PASSED/)?.[1]);
const evidenceTotal = Number(evidenceNegative.stdout.match(/NEGATIVE CONTROLS SUITE R7: (\d+) \/ (\d+) PASSED/)?.[2]);

const claims = {
    schemaVersion: 2,
    runId,
    v1Sha256: '96D6F8407DF3B4E5D3DDB4CBEB42F6430F221C909B56353118D3B14D3777884B',
    unit: { ...unitResult, exitCode: unit.command.exitCode },
    browser: { ...browserResult, exitCode: browser.command.exitCode },
    performance: perf,
    negativeControls: {
        evidencePassed, evidenceFailed: evidenceTotal - evidencePassed, exitCode: evidenceNegative.command.exitCode,
        campaignPassed: campaignResult.passed, campaignFailed: campaignResult.failed, campaignExitCode: campaignNegative.command.exitCode,
    },
};
const claimsPath = path.join(campaign, 'claims.json');
fs.writeFileSync(claimsPath, JSON.stringify(claims, null, 2));
run('45-report', [process.execPath, 'scripts/generate-report.mjs', '--run', runId], 30000);
run('46-manifest', [process.execPath, 'scripts/generate-manifest.mjs'], 30000);
const evidenceGate = run('50-final-gate', [process.execPath, 'scripts/verify-evidence.mjs'], 120000);

const phases = [preflight, unit, browser, performance, evidenceNegative, evidenceGate];
const states = ['PREFLIGHT_PASS', 'UNIT_PASS', 'BROWSER_PASS', 'PERFORMANCE_PASS', 'NEGATIVE_CONTROLS_PASS', 'FINAL_GATE_PASS'];
const ledger = [{ schemaVersion: 2, runId, state: 'CREATED', timestampUtc: createdUtc, command: null }];
for (let i = 0; i < phases.length; i++) {
    const timestampUtc = states[i] === 'PERFORMANCE_PASS' ? perf.endedUtc : phases[i].command.endedUtc;
    ledger.push({ schemaVersion: 2, runId, state: states[i], timestampUtc, command: phases[i].command });
}
ledger.push({ schemaVersion: 2, runId, state: 'READY_TO_FREEZE', timestampUtc: new Date().toISOString(), command: null });
const ledgerPath = path.join(campaign, 'ledger.jsonl');
fs.writeFileSync(ledgerPath, ledger.map(JSON.stringify).join('\n') + '\n');
fs.copyFileSync(path.join(root, 'evidence', 'manifest.json'), path.join(campaign, 'artifact-manifest.json'));

const specPath = path.join(workspace, 'review', `spec_${runId}_mission02_final_acquittal.md`);
const spec = `# Mission-02 R9 Final Acquittal Evidence\n\n` +
`- review_target: ${root}\n- comparison_base: frozen baseline ZIP SHA-256 ${claims.v1Sha256}\n` +
`- campaign: ${campaign}\n- status: success\n- risks: none\n` +
`- threat_model: file_io, exec, env_var, evidence substitution, duplicate run, hash tampering\n\n` +
`## Executed evidence\n\n` +
`- npm test: ${unitResult.passed}/${unitResult.tests}, exit ${unit.command.exitCode}, ${unit.command.startedUtc}..${unit.command.endedUtc}\n` +
`- Playwright: chromium ${browserResult.chromium.passed}, firefox ${browserResult.firefox.passed}, webkit ${browserResult.webkit.passed}, exit ${browser.command.exitCode}, ${browser.command.startedUtc}..${browser.command.endedUtc}\n` +
`- Performance: duration ${perf.measuredDurationMs}ms, samples ${perf.sampleCount}, P95 ${perf.p95LatencyMs}ms, P99 ${perf.p99LatencyMs}ms, heap ${perf.heapNetGrowthMb}MiB, long tasks ${perf.longTasksCount}, ${perf.startedUtc}..${perf.endedUtc}\n` +
`- Evidence negative controls: ${evidencePassed}/${evidenceTotal}; campaign verifier tests: ${campaignResult.passed}/${campaignResult.tests}\n` +
`- EVIDENCE_GATE: exit ${evidenceGate.command.exitCode}\n\n` +
`## Review package\n\nThe campaign contains claims.json, ledger.jsonl, artifact-manifest.json, the exact stdout/stderr logs for every command, and submission-envelope.json. Each ledger command records argv, cwd, start/end UTC, exit code, and stdout/stderr SHA-256.\n`;
fs.writeFileSync(specPath, spec, { flag: 'wx' });

const payloadHashes = {};
for (const name of ['artifact-manifest.json', 'claims.json', 'ledger.jsonl']) payloadHashes[name] = sha256(path.join(campaign, name));
const envelope = {
    schemaVersion: 2, runId, payloadHashes,
    spec: { path: specPath, sizeBytes: fs.statSync(specPath).size, sha256: sha256(specPath) },
    rawEvidence: {
        summary: { path: perfSummaryPath, sha256: sha256(perfSummaryPath) },
        samples: { path: perfSamplesPath, sha256: sha256(perfSamplesPath) },
    },
    report: { path: path.join(root, 'docs', 'final-report.md'), sha256: sha256(path.join(root, 'docs', 'final-report.md')) },
};
fs.writeFileSync(path.join(campaign, 'submission-envelope.json'), JSON.stringify(envelope, null, 2), { flag: 'wx' });
fs.chmodSync(specPath, 0o444);
console.log(`CAMPAIGN_READY run=${runId}`);
console.log(`SPEC=${specPath}`);
