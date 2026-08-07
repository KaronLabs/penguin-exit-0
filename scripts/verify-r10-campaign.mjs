import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserCountsAreComplete, parsePassingBrowserCounts } from './campaign-evidence.mjs';
import {
    FROZEN_GAME_CORE_SHA256,
    assertR10RunId,
    buildR10PhasePlan,
    collectInventory,
    contentInventorySha256,
    inventoriesEqual,
    pathInventorySha256,
    sha256File,
    tapCounts,
    validatePerformanceEvidence,
} from './r10-campaign-lib.mjs';

const REQUIRED_PAYLOADS = ['artifact-manifest.json', 'candidate-inventory.json', 'claims.json', 'ledger.jsonl', 'r9-before.json', 'r9-after.json'];
const REQUIRED_STATES = [
    'CREATED',
    'SOURCE_INVENTORY_PASS',
    'CLEAN_COPY_PASS',
    'NPM_CI_PASS',
    'PREFLIGHT_PASS',
    'UNIT_PASS',
    'BROWSER_PASS',
    'PERFORMANCE_PASS',
    'MANIFEST_PASS',
    'EVIDENCE_GATE_PASS',
    'NEGATIVE_CONTROLS_PASS',
    'CAMPAIGN_VERIFIER_TESTS_PASS',
    'PACKAGE_READY_FOR_GATE',
];
const ARTIFACT_EXCLUSIONS = new Set([
    'artifact-manifest.json',
    'submission-envelope.json',
    'campaign-receipt.json',
    'NO_GO.json',
]);

function invariant(condition, message) {
    if (!condition) throw new Error(message);
}

function readJson(file, label) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`${label} missing or invalid: ${error.message}`);
    }
}

function artifactFiles(root) {
    const files = [];
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            if (entry.isFile() && ARTIFACT_EXCLUSIONS.has(entry.name)) continue;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(absolute);
            else if (entry.isFile()) {
                const stat = fs.statSync(absolute);
                files.push({
                    path: path.relative(root, absolute).split(path.sep).join('/'),
                    sizeBytes: stat.size,
                    sha256: sha256File(absolute),
                });
            }
        }
    }
    walk(root);
    return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export function collectArtifactManifest(campaignDir) {
    const files = artifactFiles(campaignDir);
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

function verifyCommand(command, campaignDir, phase, sourceRoot) {
    invariant(command && Array.isArray(command.argv) && command.argv.length > 0, 'ledger command argv missing');
    invariant(path.isAbsolute(command.cwd), 'ledger command cwd must be absolute');
    invariant(Number.isFinite(Date.parse(command.startedUtc)) && Number.isFinite(Date.parse(command.endedUtc)), 'ledger command timestamps invalid');
    invariant(Date.parse(command.startedUtc) <= Date.parse(command.endedUtc), 'ledger command timestamp order invalid');
    invariant(command.exitCode === 0 && command.timedOut === false, 'ledger command failed or timed out');
    invariant(command.key === phase.key, `ledger command key mismatch for ${phase.state}`);
    invariant(JSON.stringify(command.argv) === JSON.stringify(phase.argv), `ledger command argv mismatch for ${phase.state}`);
    invariant(path.resolve(command.cwd) === path.resolve(sourceRoot), `ledger command cwd mismatch for ${phase.state}`);
    invariant(command.timeoutMs === phase.timeoutMs, `ledger command timeout contract mismatch for ${phase.state}`);
    for (const stream of ['stdout', 'stderr']) {
        const artifactKey = `${stream}ArtifactPath`;
        const hashKey = `${stream}Sha256`;
        invariant(typeof command[artifactKey] === 'string', `${stream} artifact path missing`);
        const file = path.resolve(campaignDir, ...command[artifactKey].split('/'));
        invariant(file.startsWith(`${path.resolve(campaignDir)}${path.sep}`), `${stream} artifact escapes campaign`);
        invariant(fs.existsSync(file) && sha256File(file) === command[hashKey], `${stream} artifact hash mismatch`);
    }
}

function commandStdout(command, campaignDir) {
    return fs.readFileSync(path.resolve(campaignDir, ...command.stdoutArtifactPath.split('/')), 'utf8');
}

function verifyR9Snapshot(snapshot, label) {
    invariant(snapshot && Number.isInteger(snapshot.fileCount) && snapshot.fileCount > 0 && Array.isArray(snapshot.files), `${label} R9 snapshot missing`);
    invariant(snapshot.fileCount === snapshot.files.length, `${label} R9 snapshot file count mismatch`);
    invariant(snapshot.pathListSha256 === pathInventorySha256(snapshot.files), `${label} R9 path digest mismatch`);
    invariant(snapshot.digest === contentInventorySha256(snapshot.files), `${label} R9 content digest mismatch`);
    const ordered = [...snapshot.files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
    invariant(JSON.stringify(ordered) === JSON.stringify(snapshot.files), `${label} R9 files are not ordered`);
}

export function verifyR10Package({ campaignDir, specPath, sourceRoot, executionRoot = sourceRoot, expectedRunId, expectedGameCoreSha256 = FROZEN_GAME_CORE_SHA256 }) {
    assertR10RunId(expectedRunId);
    const campaign = path.resolve(campaignDir);
    const source = path.resolve(sourceRoot);
    const execution = path.resolve(executionRoot);
    const spec = path.resolve(specPath);
    invariant(fs.existsSync(campaign) && fs.statSync(campaign).isDirectory(), 'campaign directory missing');

    const candidate = readJson(path.join(campaign, 'candidate-inventory.json'), 'candidate inventory');
    const current = collectInventory(source);
    invariant(inventoriesEqual(candidate, current), 'source inventory does not exactly match candidate inventory');
    invariant(candidate.pathListSha256 === pathInventorySha256(candidate.files), 'candidate path inventory digest mismatch');
    invariant(candidate.contentRecordsSha256 === contentInventorySha256(candidate.files), 'candidate content inventory digest mismatch');
    invariant(sha256File(path.join(source, 'game-core.js')) === expectedGameCoreSha256, 'game-core.js frozen SHA-256 mismatch');

    const claims = readJson(path.join(campaign, 'claims.json'), 'claims');
    invariant(claims.schemaVersion === 3 && claims.runId === expectedRunId, 'claims run/schema mismatch');
    invariant(claims.candidateInventory?.fileCount === candidate.fileCount
        && claims.candidateInventory?.pathListSha256 === candidate.pathListSha256
        && claims.candidateInventory?.contentRecordsSha256 === candidate.contentRecordsSha256, 'claims candidate inventory mismatch');
    invariant(claims.gameCoreSha256 === expectedGameCoreSha256, 'claims game-core hash mismatch');
    invariant(claims.unit?.tests === 29 && claims.unit?.passed === 29 && claims.unit?.failed === 0 && claims.unit?.exitCode === 0, 'unit evidence is not exact 29/29');
    invariant(claims.browser?.exitCode === 0 && browserCountsAreComplete(claims.browser), 'browser evidence is not exact 39/39');
    invariant(claims.negativeControls?.passed === 21 && claims.negativeControls?.total === 21
        && claims.negativeControls?.failed === 0 && claims.negativeControls?.exitCode === 0, 'negative controls are not exact 21/21');
    invariant(Number.isInteger(claims.campaignVerifier?.tests) && claims.campaignVerifier.tests > 0
        && claims.campaignVerifier.passed === claims.campaignVerifier.tests
        && claims.campaignVerifier.failed === 0 && claims.campaignVerifier.exitCode === 0, 'campaign verifier tests incomplete');
    const r9Before = readJson(path.join(campaign, 'r9-before.json'), 'R9 before snapshot');
    const r9After = readJson(path.join(campaign, 'r9-after.json'), 'R9 after snapshot');
    verifyR9Snapshot(r9Before, 'before');
    verifyR9Snapshot(r9After, 'after');
    invariant(JSON.stringify(r9Before) === JSON.stringify(r9After), 'R9 before/after snapshots differ');
    invariant(claims.r9Frozen?.fileCount === r9Before.fileCount
        && claims.r9Frozen?.pathListSha256 === r9Before.pathListSha256
        && claims.r9Frozen?.beforeDigest === r9Before.digest
        && claims.r9Frozen?.afterDigest === r9After.digest, 'R9 frozen claims do not bind exact snapshots');
    invariant(claims.actualBrowserZoom?.claimed === false
        && claims.actualBrowserZoom?.equivalentReflow === '3-engine 640x360 equivalent PASS'
        && claims.actualBrowserZoom?.limitation === 'actual browser chrome zoom not claimed', 'browser zoom limitation is missing or overstated');

    const raw = readJson(path.join(campaign, 'frame-samples.json'), 'raw performance');
    const summary = readJson(path.join(campaign, 'performance-summary.json'), 'performance summary');
    validatePerformanceEvidence(summary, raw, {});
    invariant(JSON.stringify(claims.performance) === JSON.stringify(summary), 'claims performance summary mismatch');

    const ledgerText = fs.readFileSync(path.join(campaign, 'ledger.jsonl'), 'utf8').trim();
    const ledger = ledgerText.split(/\r?\n/).map((line) => JSON.parse(line));
    invariant(JSON.stringify(ledger.map((entry) => entry.state)) === JSON.stringify(REQUIRED_STATES), 'ledger ordered states mismatch');
    let previousTimestamp = 0;
    const phasePlan = buildR10PhasePlan(execution);
    for (const [index, entry] of ledger.entries()) {
        const timestamp = Date.parse(entry.timestampUtc);
        invariant(entry.schemaVersion === 3 && entry.runId === expectedRunId && Number.isFinite(timestamp) && timestamp >= previousTimestamp, 'ledger provenance invalid');
        previousTimestamp = timestamp;
        if (index >= 3 && index <= 11) verifyCommand(entry.command, campaign, phasePlan[index - 3], execution);
        else invariant(entry.command === null, `unexpected command receipt for ledger state ${entry.state}`);
    }
    const phaseCommands = Object.fromEntries(ledger.slice(3, 12).map((entry) => [entry.command.key, entry.command]));
    invariant(commandStdout(phaseCommands['20-preflight'], campaign).includes('Preflight status: match=true'), 'preflight stdout proof missing');
    const unitLog = tapCounts(commandStdout(phaseCommands['30-unit'], campaign));
    invariant(unitLog.tests === claims.unit.tests && unitLog.passed === claims.unit.passed && unitLog.failed === claims.unit.failed, 'unit stdout counts do not match claims');
    const browserLog = parsePassingBrowserCounts(commandStdout(phaseCommands['40-browser'], campaign), phaseCommands['40-browser'].exitCode);
    invariant(browserCountsAreComplete(browserLog) && JSON.stringify(browserLog) === JSON.stringify({
        chromium: claims.browser.chromium,
        firefox: claims.browser.firefox,
        webkit: claims.browser.webkit,
        integrity: claims.browser.integrity,
        reportedFailures: claims.browser.reportedFailures,
    }), 'browser stdout counts do not match claims');
    const performanceLog = commandStdout(phaseCommands['50-performance'], campaign);
    invariant(performanceLog.includes('[PERF] Warming up for 30s...')
        && performanceLog.includes('[PERF] Starting workload measurement loop for 600s...'), 'performance warm-up/workload stdout proof missing');
    const performanceWallMs = Date.parse(phaseCommands['50-performance'].endedUtc) - Date.parse(phaseCommands['50-performance'].startedUtc);
    const warmupToMeasurementMs = Date.parse(raw.startedUtc) - Date.parse(phaseCommands['50-performance'].startedUtc);
    invariant(performanceWallMs >= 630000 && warmupToMeasurementMs >= 29500, 'performance command does not prove 30s warm-up plus 600s measurement');
    invariant(Date.parse(phaseCommands['50-performance'].endedUtc) >= Date.parse(raw.endedUtc), 'performance command ended before raw measurement');
    invariant(commandStdout(phaseCommands['60-manifest'], campaign).includes('[MANIFEST GENERATOR]'), 'manifest stdout proof missing');
    invariant(commandStdout(phaseCommands['61-evidence-gate'], campaign).includes('EVIDENCE_GATE=GO'), 'evidence gate stdout proof missing');
    const negativeMatch = commandStdout(phaseCommands['70-negative-controls'], campaign).match(/NEGATIVE CONTROLS SUITE R7:\s+(\d+)\s+\/\s+(\d+)\s+PASSED/);
    invariant(negativeMatch && Number(negativeMatch[1]) === claims.negativeControls.passed
        && Number(negativeMatch[2]) === claims.negativeControls.total, 'negative-control stdout counts do not match claims');
    const campaignLog = tapCounts(commandStdout(phaseCommands['71-campaign-verifier-tests'], campaign));
    invariant(campaignLog.tests === claims.campaignVerifier.tests
        && campaignLog.passed === claims.campaignVerifier.passed
        && campaignLog.failed === claims.campaignVerifier.failed, 'campaign-verifier stdout counts do not match claims');

    const storedManifest = readJson(path.join(campaign, 'artifact-manifest.json'), 'artifact manifest');
    const actualManifest = collectArtifactManifest(campaign);
    invariant(JSON.stringify(storedManifest) === JSON.stringify(actualManifest), 'artifact manifest exact membership/hash mismatch');

    const envelope = readJson(path.join(campaign, 'submission-envelope.json'), 'submission envelope');
    invariant(envelope.schemaVersion === 3 && envelope.runId === expectedRunId, 'envelope run/schema mismatch');
    invariant(JSON.stringify(Object.keys(envelope.payloadHashes ?? {}).sort()) === JSON.stringify([...REQUIRED_PAYLOADS].sort()), 'envelope payload set mismatch');
    for (const name of REQUIRED_PAYLOADS) {
        invariant(envelope.payloadHashes[name] === sha256File(path.join(campaign, name)), `payload hash mismatch: ${name}`);
    }
    invariant(envelope.source?.path === 'source-snapshot' && envelope.source?.fileCount === candidate.fileCount
        && envelope.source?.pathListSha256 === candidate.pathListSha256
        && envelope.source?.contentRecordsSha256 === candidate.contentRecordsSha256, 'envelope source binding mismatch');
    invariant(envelope.spec?.fileName === `spec_${expectedRunId}_mission02_r10_korean_release.md` && fs.existsSync(spec)
        && envelope.spec.sizeBytes === fs.statSync(spec).size && envelope.spec.sha256 === sha256File(spec), 'envelope spec binding mismatch');
    invariant(envelope.rawEvidence?.summary?.path === 'performance-summary.json'
        && envelope.rawEvidence.summary.sha256 === sha256File(path.join(campaign, 'performance-summary.json'))
        && envelope.rawEvidence?.samples?.path === 'frame-samples.json'
        && envelope.rawEvidence.samples.sha256 === sha256File(path.join(campaign, 'frame-samples.json')), 'envelope raw performance binding mismatch');
    const specText = fs.readFileSync(spec, 'utf8');
    invariant(specText.includes(expectedRunId) && specText.includes(candidate.pathListSha256)
        && specText.includes(candidate.contentRecordsSha256)
        && specText.includes('actual browser chrome zoom not claimed'), 'spec omits bound run, inventory, or zoom limitation');

    return {
        status: 'VERIFIED',
        runId: expectedRunId,
        candidateFileCount: candidate.fileCount,
        candidatePathListSha256: candidate.pathListSha256,
        campaignArtifactCount: storedManifest.fileCount,
        performance: validatePerformanceEvidence(summary, raw, {}),
    };
}

function argument(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : null;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    try {
        const result = verifyR10Package({
            campaignDir: argument('--campaign'),
            specPath: argument('--spec'),
            sourceRoot: argument('--source'),
            executionRoot: argument('--execution-source') ?? argument('--source'),
            expectedRunId: argument('--run'),
        });
        console.log(`R10_CAMPAIGN_GATE=${result.status}`);
        console.log(JSON.stringify(result));
    } catch (error) {
        console.error(`R10_CAMPAIGN_GATE=NO_GO reason=${error.message}`);
        process.exitCode = 1;
    }
}
