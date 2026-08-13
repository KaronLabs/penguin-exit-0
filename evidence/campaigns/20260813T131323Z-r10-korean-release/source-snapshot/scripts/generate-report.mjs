import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runIndex = process.argv.indexOf('--run');
const runId = runIndex >= 0 ? process.argv[runIndex + 1] : null;
if (!runId) throw new Error('Usage: node scripts/generate-report.mjs --run <run-id>');

const campaign = path.join(root, 'evidence', 'campaigns', runId);
const summary = JSON.parse(fs.readFileSync(path.join(root, 'evidence', 'performance', 'performance-summary.json')));
const claims = JSON.parse(fs.readFileSync(path.join(campaign, 'claims.json')));
const lines = [
    '# Penguin EXIT 0 — Commercial Edition v2.1',
    '## Final Engineering Report (Generated from Bound Evidence)',
    '',
    `- Campaign: \`${runId}\``,
    `- Generated UTC: \`${new Date().toISOString()}\``,
    `- Baseline ZIP SHA-256: \`${claims.v1Sha256}\``,
    '',
    '### Executed test results',
    '',
    '| Suite | Passed | Failed | Exit |',
    '|---|---:|---:|---:|',
    `| Node TAP | ${claims.unit.passed} | ${claims.unit.failed} | ${claims.unit.exitCode} |`,
    `| Chromium | ${claims.browser.chromium.passed} | ${claims.browser.chromium.failed} | ${claims.browser.exitCode} |`,
    `| Firefox | ${claims.browser.firefox.passed} | ${claims.browser.firefox.failed} | ${claims.browser.exitCode} |`,
    `| WebKit | ${claims.browser.webkit.passed} | ${claims.browser.webkit.failed} | ${claims.browser.exitCode} |`,
    `| Evidence negative controls | ${claims.negativeControls.evidencePassed} | ${claims.negativeControls.evidenceFailed} | ${claims.negativeControls.exitCode} |`,
    `| Campaign verifier tests | ${claims.negativeControls.campaignPassed} | ${claims.negativeControls.campaignFailed} | ${claims.negativeControls.campaignExitCode} |`,
    '',
    '### Performance raw values',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Measured duration ms | ${summary.measuredDurationMs} |`,
    `| Sample count | ${summary.sampleCount} |`,
    `| P50 latency ms | ${summary.p50LatencyMs} |`,
    `| P95 latency ms | ${summary.p95LatencyMs} |`,
    `| P99 latency ms | ${summary.p99LatencyMs} |`,
    `| Long tasks | ${summary.longTasksCount} |`,
    `| Heap net growth MiB | ${summary.heapNetGrowthMb} |`,
    `| Started UTC | ${summary.startedUtc} |`,
    `| Ended UTC | ${summary.endedUtc} |`,
    '',
    'All values above are generated from `claims.json` and `performance-summary.json` for this campaign.',
];
fs.writeFileSync(path.join(root, 'docs', 'final-report.md'), lines.join('\n') + '\n');
console.log(`REPORT_GENERATED run=${runId}`);
