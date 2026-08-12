import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredStates = [
    'CREATED', 'PREFLIGHT_PASS', 'UNIT_PASS', 'BROWSER_PASS',
    'PERFORMANCE_PASS', 'NEGATIVE_CONTROLS_PASS', 'FINAL_GATE_PASS', 'READY_TO_FREEZE',
];
const requiredPayloads = ['artifact-manifest.json', 'claims.json', 'ledger.jsonl'];
const runIndex = process.argv.indexOf('--run');
const runId = runIndex >= 0 ? process.argv[runIndex + 1] : null;

if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    console.error('[ERROR] Usage: node scripts/verify-campaign.mjs --run <run-id>');
    process.exit(1);
}

const campaignDir = path.join(rootDir, 'evidence', 'campaigns', runId);
let allPass = true;
const results = {};

function hash(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function pass(key, message) {
    results[key] = true;
    console.log(`[PASS] ${key}: ${message}`);
}

function fail(key, message) {
    results[key] = false;
    allPass = false;
    console.error(`[FAIL] ${key}: ${message}`);
}

function readJson(file, key) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        fail(key, `${path.basename(file)} is missing or invalid JSON: ${error.message}`);
        return null;
    }
}

if (!fs.existsSync(campaignDir)) {
    console.error(`[ERROR] Campaign directory not found: ${campaignDir}`);
    process.exit(1);
}

console.log(`=== CAMPAIGN VERIFIER — Run: ${runId} ===`);
const ledgerPath = path.join(campaignDir, 'ledger.jsonl');
let entries = [];
try {
    entries = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
} catch (error) {
    fail('LEDGER_PROVENANCE_VALID', `ledger.jsonl is missing or invalid: ${error.message}`);
}

if (entries.length) {
    const states = entries.map((entry) => entry.state);
    let valid = JSON.stringify(states) === JSON.stringify(requiredStates);
    let previous = 0;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const timestamp = Date.parse(entry.timestampUtc);
        if (entry.runId !== runId || !Number.isFinite(timestamp) || timestamp < previous) valid = false;
        previous = timestamp;
        if (i > 0 && i < entries.length - 1) {
            const command = entry.command;
            const hashesValid = command && /^[A-F0-9]{64}$/.test(command.stdoutSha256)
                && /^[A-F0-9]{64}$/.test(command.stderrSha256);
            if (!hashesValid || !Array.isArray(command.argv) || !path.isAbsolute(command.cwd)
                || command.exitCode !== 0 || Date.parse(command.startedUtc) > Date.parse(command.endedUtc)) {
                valid = false;
            }
        }
    }
    valid ? pass('LEDGER_PROVENANCE_VALID', 'exact ordered states and command receipts are valid')
        : fail('LEDGER_PROVENANCE_VALID', `expected exact states ${requiredStates.join(', ')}`);
}

const rootManifest = path.join(rootDir, 'evidence', 'manifest.json');
const campaignManifest = path.join(campaignDir, 'artifact-manifest.json');
if (fs.existsSync(rootManifest) && fs.existsSync(campaignManifest) && hash(rootManifest) === hash(campaignManifest)) {
    pass('ARTIFACT_MANIFEST_MATCH', `SHA-256=${hash(rootManifest)}`);
} else {
    fail('ARTIFACT_MANIFEST_MATCH', 'campaign artifact manifest does not equal the root manifest');
}

const envelopePath = path.join(campaignDir, 'submission-envelope.json');
const envelope = readJson(envelopePath, 'ENVELOPE_VALID');
if (envelope) {
    const keys = Object.keys(envelope.payloadHashes ?? {}).sort();
    let valid = envelope.schemaVersion === 2 && envelope.runId === runId
        && JSON.stringify(keys) === JSON.stringify(requiredPayloads);
    for (const name of requiredPayloads) {
        const file = path.join(campaignDir, name);
        valid = valid && fs.existsSync(file) && envelope.payloadHashes[name] === hash(file);
    }
    valid ? pass('ENVELOPE_VALID', 'exact required payload set and hashes match')
        : fail('ENVELOPE_VALID', 'schema, run id, exact payload set, or payload hash mismatch');

    const spec = envelope.spec;
    const specValid = spec && path.isAbsolute(spec.path) && fs.existsSync(spec.path)
        && spec.sizeBytes === fs.statSync(spec.path).size && spec.sha256 === hash(spec.path);
    specValid ? pass('SPEC_BINDING_VALID', `${spec.path} SHA-256=${spec.sha256}`)
        : fail('SPEC_BINDING_VALID', 'spec path, size, or SHA-256 binding mismatch');

    const raw = envelope.rawEvidence;
    const summaryRef = raw?.summary;
    const samplesRef = raw?.samples;
    const rawHashesValid = summaryRef && samplesRef && path.isAbsolute(summaryRef.path)
        && path.isAbsolute(samplesRef.path) && fs.existsSync(summaryRef.path) && fs.existsSync(samplesRef.path)
        && summaryRef.sha256 === hash(summaryRef.path) && samplesRef.sha256 === hash(samplesRef.path);
    if (!rawHashesValid) {
        fail('RAW_BINDING_VALID', 'raw summary/sample paths or SHA-256 bindings mismatch');
    } else {
        const summary = readJson(summaryRef.path, 'RAW_BINDING_VALID');
        const samples = readJson(samplesRef.path, 'RAW_BINDING_VALID');
        const deltas = samples?.frameDeltasMs;
        const perf = entries.find((entry) => entry.state === 'PERFORMANCE_PASS');
        const semanticsValid = summary && samples && Array.isArray(deltas)
            && summary.sampleCount === deltas.length && summary.sampleCount >= 10000
            && summary.measuredDurationMs >= 600000
            && summary.startedUtc === samples.startedUtc && summary.endedUtc === samples.endedUtc
            && perf?.timestampUtc === summary.endedUtc;
        semanticsValid ? pass('RAW_BINDING_VALID', `duration=${summary.measuredDurationMs}ms samples=${summary.sampleCount}`)
            : fail('RAW_BINDING_VALID', 'raw timestamps, duration, sample count, or ledger provenance mismatch');
    }

    const reportRef = envelope.report;
    const claimsPath = path.join(campaignDir, 'claims.json');
    const claims = readJson(claimsPath, 'REPORT_CLAIMS_VALID');
    const reportBound = reportRef && path.isAbsolute(reportRef.path) && fs.existsSync(reportRef.path)
        && reportRef.sha256 === hash(reportRef.path);
    if (!reportBound || !claims) {
        fail('REPORT_CLAIMS_VALID', 'report path/hash binding or claims are missing');
    } else {
        const report = fs.readFileSync(reportRef.path, 'utf8');
        const summary = JSON.parse(fs.readFileSync(summaryRef.path, 'utf8'));
        const expectedLines = [
            `| Node TAP | ${claims.unit.passed} | ${claims.unit.failed} | ${claims.unit.exitCode} |`,
            `| Chromium | ${claims.browser.chromium.passed} | ${claims.browser.chromium.failed} | ${claims.browser.exitCode} |`,
            `| Firefox | ${claims.browser.firefox.passed} | ${claims.browser.firefox.failed} | ${claims.browser.exitCode} |`,
            `| WebKit | ${claims.browser.webkit.passed} | ${claims.browser.webkit.failed} | ${claims.browser.exitCode} |`,
            `| Measured duration ms | ${summary.measuredDurationMs} |`,
            `| Sample count | ${summary.sampleCount} |`,
        ];
        const reportValid = expectedLines.every((line) => report.split(/\r?\n/).includes(line));
        reportValid ? pass('REPORT_CLAIMS_VALID', 'report rows match bound claims and raw performance')
            : fail('REPORT_CLAIMS_VALID', 'one or more generated report rows disagree with bound claims/raw data');
    }
}

console.log('=== CAMPAIGN VERIFICATION SUMMARY ===');
for (const [key, value] of Object.entries(results)) console.log(`${value ? 'PASS' : 'FAIL'} ${key}`);
console.log(`CAMPAIGN_GATE=${allPass ? 'PASS' : 'FAIL'}`);
process.exit(allPass ? 0 : 1);
