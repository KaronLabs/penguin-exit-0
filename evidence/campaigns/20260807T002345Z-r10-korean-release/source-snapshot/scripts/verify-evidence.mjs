/**
 * verify-evidence.mjs — Raw-First Fail-Closed Evidence Gate (R7 Clean)
 *
 * Rules:
 *  1. PERF_FAST env var must NOT exist — if it does: instant NO_GO.
 *  2. baseline-preflight.log must assert match=true.
 *  3. Raw frame-samples.json array length must be computed from the array itself,
 *     then compared against summary sampleCount with exact equality.
 *  4. P95 / P99 re-calculated from raw array must match summary within ±0.1ms.
 *  5. Long tasks observer must be supported and count must be 0.
 *  6. Heap net growth must be <= 5.0 MiB.
 *  7. Manifest totalFilesCount must equal files array length exactly.
 *  8. Every file in manifest must still exist on disk with the same SHA-256.
 *  9. Number of scanned source files must equal manifest.files.length exactly.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../');

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function scanDir(dir, list = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(rootDir, full).replace(/\\/g, '/');
        if (
            rel.startsWith('node_modules') ||
            rel.startsWith('test-results') ||
            rel.startsWith('playwright-report') ||
            rel.startsWith('.git') ||
            rel.startsWith('.agents') ||
            rel.startsWith('.campaign-operations') ||
            rel === 'evidence/manifest.json' ||
            rel.startsWith('evidence/campaigns')
        ) continue;
        if (entry.isDirectory()) scanDir(full, list);
        else list.push({ path: rel, sha256: sha256(full) });
    }
    return list;
}

function percentile(arr, ratio) {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function fail(msg) {
    console.error(`[FAIL-CLOSED] ${msg}`);
    console.log('EVIDENCE_GATE=NO_GO');
    process.exit(1);
}

console.log('--- STARTING RAW-FIRST FAIL-CLOSED EVIDENCE GATE (R7) ---');

// 0. PERF_FAST bypass detector — highest priority kill switch
if (process.env.PERF_FAST !== undefined) {
    fail('PERF_FAST env var detected. This is a forbidden bypass. Remove it before verification.');
}

// 1. Baseline preflight hash
const preflightPath = path.join(rootDir, 'evidence/raw/baseline-preflight.log');
if (!fs.existsSync(preflightPath)) fail('Missing evidence/raw/baseline-preflight.log');
const preflightText = fs.readFileSync(preflightPath, 'utf-8');
if (!preflightText.includes('match=true') && !preflightText.includes('match=True')) {
    fail('Baseline preflight hash mismatch!');
}
console.log('[PASS] 1/5 Baseline preflight hash verified.');

// 2. Raw-first performance verification
const summaryPath = path.join(rootDir, 'evidence/performance/performance-summary.json');
const samplesPath = path.join(rootDir, 'evidence/performance/frame-samples.json');
if (!fs.existsSync(summaryPath)) fail('Missing evidence/performance/performance-summary.json');
if (!fs.existsSync(samplesPath)) fail('Missing evidence/performance/frame-samples.json');

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
const samples = JSON.parse(fs.readFileSync(samplesPath, 'utf-8'));

// 2a. Duration — check both raw and summary agree
if ((summary.measuredDurationMs || 0) < 600000) fail(`summary.measuredDurationMs=${summary.measuredDurationMs} < 600000`);
if ((samples.measuredDurationMs || 0) < 600000) fail(`frame-samples measuredDurationMs=${samples.measuredDurationMs} < 600000`);

// 2b. Raw array existence and length
const rawDeltas = samples.frameDeltasMs;
if (!Array.isArray(rawDeltas) || rawDeltas.length === 0) fail('frame-samples.frameDeltasMs is empty or not an array');
if (rawDeltas.length < 10000) fail(`rawDeltas.length=${rawDeltas.length} < 10000 minimum`);

// 2c. Summary sampleCount must equal raw array length exactly
if (summary.sampleCount !== rawDeltas.length) {
    fail(`summary.sampleCount (${summary.sampleCount}) != rawDeltas.length (${rawDeltas.length}). Declared count differs from actual raw data.`);
}
if (summary.startedUtc !== samples.startedUtc || summary.endedUtc !== samples.endedUtc
    || summary.measuredDurationMs !== samples.measuredDurationMs) {
    fail('Summary/raw timing fields do not match exactly.');
}

// 2d. Re-calculate P95 / P99 from raw and compare with summary (± 0.1ms tolerance for float precision)
const calcP95 = percentile(rawDeltas, 0.95);
const calcP99 = percentile(rawDeltas, 0.99);
if (Math.abs(calcP95 - summary.p95LatencyMs) > 0.1) {
    fail(`P95 re-calc=${calcP95} vs summary.p95LatencyMs=${summary.p95LatencyMs}. Re-calculated value differs from declared value.`);
}
if (Math.abs(calcP99 - summary.p99LatencyMs) > 0.1) {
    fail(`P99 re-calc=${calcP99} vs summary.p99LatencyMs=${summary.p99LatencyMs}. Re-calculated value differs from declared value.`);
}

// 2e. Latency thresholds
if (calcP95 > 20.0) fail(`Raw-calculated P95 ${calcP95}ms > 20.0ms contract`);
if (calcP99 > 33.3) fail(`Raw-calculated P99 ${calcP99}ms > 33.3ms contract`);

// 2f. Long tasks
if (summary.longTaskObserverSupported !== true) fail('longTaskObserverSupported must be true');
if (summary.longTasksCount !== 0) fail(`longTasksCount=${summary.longTasksCount} must be 0`);

// 2g. Heap net growth
if (summary.heapNetGrowthMb > 5.0) fail(`heapNetGrowthMb=${summary.heapNetGrowthMb} > 5.0 MiB contract`);

console.log(`[PASS] 2/5 Raw-first 600s Performance Evidence verified (${rawDeltas.length} raw deltas, P95=${calcP95.toFixed(4)}ms, P99=${calcP99.toFixed(4)}ms, Heap=${summary.heapNetGrowthMb.toFixed(4)}MiB).`);

// 3. Manifest integrity — exact membership
const manifestPath = path.join(rootDir, 'evidence/manifest.json');
if (!fs.existsSync(manifestPath)) fail('Missing evidence/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

// 3a. totalFilesCount must equal files array length
if (typeof manifest.totalFilesCount !== 'number') fail('manifest.totalFilesCount must be a number');
if (manifest.totalFilesCount !== manifest.files.length) {
    fail(`manifest.totalFilesCount (${manifest.totalFilesCount}) != manifest.files.length (${manifest.files.length})`);
}

// 3b. Scan current disk state and compare
const diskFiles = scanDir(rootDir).sort((a, b) => a.path.localeCompare(b.path));
const manifestFiles = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));

if (diskFiles.length !== manifestFiles.length) {
    fail(`Disk file count (${diskFiles.length}) != manifest count (${manifestFiles.length})`);
}

for (let i = 0; i < manifestFiles.length; i++) {
    if (manifestFiles[i].path !== diskFiles[i].path || manifestFiles[i].sha256 !== diskFiles[i].sha256) {
        fail(`Manifest/disk mismatch at entry [${i}]: manifest="${manifestFiles[i].path}:${manifestFiles[i].sha256}" disk="${diskFiles[i].path}:${diskFiles[i].sha256}"`);
    }
}

console.log(`[PASS] 3/5 Manifest integrity verified (${manifest.files.length} tracked files, totalFilesCount=${manifest.totalFilesCount}).`);

// 4. P50 must also be derived from the same raw array.
const calcP50 = percentile(rawDeltas, 0.50);
if (Math.abs(calcP50 - summary.p50LatencyMs) > 0.1) {
    fail(`P50 re-calc=${calcP50} vs summary.p50LatencyMs=${summary.p50LatencyMs}`);
}
console.log('[PASS] 4/5 P50 raw/summary consistency verified.');

// 5. Verifier self-integrity: confirm kill-switch is present and functional
// The kill-switch: if (process.env.PERF_FAST !== undefined) → fail() must appear at top level
const verifierSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf-8');
const hasKillSwitch = verifierSrc.includes("process.env.PERF_FAST !== undefined") && verifierSrc.includes("fail(");
if (!hasKillSwitch) {
    fail('Verifier kill-switch for PERF_FAST env var is missing from source!');
}
console.log('[PASS] 5/5 Verifier self-integrity check passed (PERF_FAST kill-switch present).');

console.log('EVIDENCE_GATE=GO');
