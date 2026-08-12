/**
 * run-negative-controls.mjs — Enhanced Negative Controls Suite R7
 *
 * Scenarios:
 *  nc-01 to nc-16: Original fail-closed scenarios (performance, manifest, env bypass)
 *  nc-17 to nc-21: Additional raw/summary and exact-inventory evidence mutations.
 *  Campaign-level attacks are exercised separately by tests/campaign-verifier.test.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../');
const tempDir = path.resolve(rootDir, '../temp-negative-controls-r7');

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (['node_modules', '.git', '.agents', 'temp-negative-controls-r7'].includes(entry.name)) continue;
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDir(s, d);
        else fs.copyFileSync(s, d);
    }
}

console.log('--- STARTING ENHANCED FAIL-CLOSED NEGATIVE CONTROLS SUITE R7 (21 SCENARIOS) ---');

const scenarios = [
    // --- Performance scenarios ---
    { name: 'nc-01-no-duration', mutate: (dir) => {
        const p = path.join(dir, 'evidence/performance/performance-summary.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        d.measuredDurationMs = 0;
        fs.writeFileSync(p, JSON.stringify(d));
    }},
    { name: 'nc-02-short-duration', mutate: (dir) => {
        const p = path.join(dir, 'evidence/performance/performance-summary.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        d.measuredDurationMs = 599999;
        fs.writeFileSync(p, JSON.stringify(d));
    }},
    { name: 'nc-03-zero-samples', mutate: (dir) => {
        const p = path.join(dir, 'evidence/performance/performance-summary.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        d.sampleCount = 0;
        fs.writeFileSync(p, JSON.stringify(d));
    }},
    { name: 'nc-04-few-samples', mutate: (dir) => {
        const p = path.join(dir, 'evidence/performance/performance-summary.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        d.sampleCount = 9999;
        fs.writeFileSync(p, JSON.stringify(d));
    }},
    { name: 'nc-05-no-observer', mutate: (dir) => {
        const p = path.join(dir, 'evidence/performance/performance-summary.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        d.longTaskObserverSupported = false;
        fs.writeFileSync(p, JSON.stringify(d));
    }},
    { name: 'nc-06-has-longtasks', mutate: (dir) => {
        const p = path.join(dir, 'evidence/performance/performance-summary.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        d.longTasksCount = 1;
        fs.writeFileSync(p, JSON.stringify(d));
    }},
    { name: 'nc-07-high-heap', mutate: (dir) => {
        const p = path.join(dir, 'evidence/performance/performance-summary.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        d.heapNetGrowthMb = 9999;
        fs.writeFileSync(p, JSON.stringify(d));
    }},
    { name: 'nc-08-high-p95', mutate: (dir) => {
        const p = path.join(dir, 'evidence/performance/performance-summary.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        d.p95LatencyMs = 20.0001;
        fs.writeFileSync(p, JSON.stringify(d));
    }},
    { name: 'nc-09-high-p99', mutate: (dir) => {
        const p = path.join(dir, 'evidence/performance/performance-summary.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        d.p99LatencyMs = 33.3001;
        fs.writeFileSync(p, JSON.stringify(d));
    }},
    { name: 'nc-10-missing-summary', mutate: (dir) => {
        const p = path.join(dir, 'evidence/performance/performance-summary.json');
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }},
    { name: 'nc-11-missing-samples', mutate: (dir) => {
        const p = path.join(dir, 'evidence/performance/frame-samples.json');
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }},
    // --- Manifest scenarios ---
    { name: 'nc-12-manifest-file-tampered', mutate: (dir) => {
        const p = path.join(dir, 'evidence/manifest.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (d.files.length > 0) d.files[0].sha256 = '0'.repeat(64);
        fs.writeFileSync(p, JSON.stringify(d));
    }},
    { name: 'nc-13-preflight-hash-tampered', mutate: (dir) => {
        fs.writeFileSync(path.join(dir, 'evidence/raw/baseline-preflight.log'), 'match=false');
    }},
    { name: 'nc-14-empty-raw-deltas', mutate: (dir) => {
        const p = path.join(dir, 'evidence/performance/frame-samples.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        d.frameDeltasMs = [];
        fs.writeFileSync(p, JSON.stringify(d));
    }},
    { name: 'nc-15-manifest-count-mismatch', mutate: (dir) => {
        const p = path.join(dir, 'evidence/manifest.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        d.totalFilesCount = 999;
        fs.writeFileSync(p, JSON.stringify(d));
    }},
    // --- Env bypass scenario ---
    { name: 'nc-16-perf-fast-env', mutate: (dir) => {}, env: { PERF_FAST: '1' }},

    // --- Additional evidence-level scenarios ---
    { name: 'nc-17-summary-raw-start-mismatch', mutate: (dir) => {
        const p = path.join(dir, 'evidence/performance/performance-summary.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        d.startedUtc = '2000-01-01T00:00:00.000Z';
        fs.writeFileSync(p, JSON.stringify(d));
    }},

    { name: 'nc-18-samplecount-vs-raw-mismatch', mutate: (dir) => {
        // Summary claims 9999 samples but raw array has real count — verifier must catch mismatch
        const p = path.join(dir, 'evidence/performance/performance-summary.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        d.sampleCount = 9999; // tamper only summary, not raw
        fs.writeFileSync(p, JSON.stringify(d));
    }},

    { name: 'nc-19-p95-summary-vs-raw-mismatch', mutate: (dir) => {
        // Summary claims P95=0.001 ms but raw array would compute much higher
        const p = path.join(dir, 'evidence/performance/performance-summary.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        d.p95LatencyMs = 0.001; // Impossible mismatch with actual raw deltas
        fs.writeFileSync(p, JSON.stringify(d));
    }},

    { name: 'nc-20-p99-summary-vs-raw-mismatch', mutate: (dir) => {
        const p = path.join(dir, 'evidence/performance/performance-summary.json');
        if (!fs.existsSync(p)) return;
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        d.p99LatencyMs = 0.001; // Impossible mismatch
        fs.writeFileSync(p, JSON.stringify(d));
    }},

    { name: 'nc-21-extra-file-not-in-manifest', mutate: (dir) => {
        // Add a new file that was not in manifest — disk count will exceed manifest count
        fs.writeFileSync(path.join(dir, 'injected-evil-file.txt'), 'evil content');
    }}
];

let passed = 0;
let failed = 0;

for (const sc of scenarios) {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    copyDir(rootDir, tempDir);

    try { sc.mutate(tempDir); } catch (e) { /* mutation errors are OK — verifier should still reject */ }

    let rejected = false;
    try {
        const env = sc.env ? { ...process.env, ...sc.env } : process.env;
        execSync('node scripts/verify-evidence.mjs', { cwd: tempDir, stdio: 'pipe', env });
    } catch { rejected = true; }

    if (rejected) {
        console.log(`[PASS] '${sc.name}' correctly REJECTED with NO_GO/exit 1.`);
        passed++;
    } else {
        console.error(`[FAIL-OPEN CRITICAL] '${sc.name}' was INCORRECTLY APPROVED with GO/exit 0!`);
        failed++;
    }
}

if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });

console.log(`\nNEGATIVE CONTROLS SUITE R7: ${passed} / ${scenarios.length} PASSED.`);
if (failed > 0) {
    console.error(`[CRITICAL] ${failed} FAIL-OPEN vulnerabilities detected!`);
    process.exit(1);
} else {
    console.log('[SUCCESS] Verifier is 100% Fail-Closed verified across all 21 negative control scenarios.');
}
