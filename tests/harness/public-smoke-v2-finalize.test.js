import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as finalizer from '../../scripts/finalize-public-smoke-v2.mjs';
import * as smoke from '../../scripts/public-smoke-v2-lib.mjs';

const FINAL_KEYS = [
    'schemaVersion', 'releaseId', 'status', 'createdUtc', 'finalizerPath', 'finalizerSha256', 'configSha256',
    'campaignVerifierProofSha256', 'operationReceiptSha256', 'auditReceiptSha256', 'negativeReceiptSha256',
    'closureReceiptSha256', 'actualChromeEvidencePath', 'actualChromeEvidenceSha256', 'acceptedManifestSha256',
    'eventsSha256', 'finalEventSha256', 'deploymentId', 'immutableUrl', 'aliasUrl', 'fileGates', 'smokeGate',
    'negativeGate', 'screenshotBindings', 'actualChrome', 'productFiles',
];

function sha(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function inventory(root) {
    const files = [];
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(absolute);
            else {
                const relative = path.relative(root, absolute).split(path.sep).join('/');
                const bytes = fs.readFileSync(absolute);
                files.push({ path: relative, sizeBytes: bytes.length, sha256: sha(bytes) });
            }
        }
    }
    walk(root);
    files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    return {
        schemaVersion: 1,
        algorithm: 'SHA-256',
        pathEncoding: 'UTF-8 NUL-terminated ordered path records',
        fileCount: files.length,
        pathListSha256: sha(Buffer.from(files.map(({ path: relative }) => `${relative}\0`).join(''))),
        contentRecordsSha256: sha(Buffer.from(files.map(({ path: relative, sizeBytes, sha256 }) => `${relative}\0${sizeBytes}\0${sha256}\0`).join(''))),
        files,
    };
}

function bindFinalizerIntoCampaign(fixture) {
    const finalizerPath = new URL('../../scripts/finalize-public-smoke-v2.mjs', import.meta.url);
    const snapshotPath = path.join(fixture.sourceSnapshot, 'scripts', 'finalize-public-smoke-v2.mjs');
    fs.copyFileSync(finalizerPath, snapshotPath);
    const candidate = inventory(fixture.sourceSnapshot);
    const candidatePath = path.join(fixture.campaignDir, 'candidate-inventory.json');
    writeJson(candidatePath, candidate);
    const claimsPath = path.join(fixture.campaignDir, 'claims.json');
    const claims = readJson(claimsPath);
    claims.candidateInventory = {
        fileCount: candidate.fileCount,
        pathListSha256: candidate.pathListSha256,
        contentRecordsSha256: candidate.contentRecordsSha256,
    };
    writeJson(claimsPath, claims);
    const envelopePath = path.join(fixture.campaignDir, 'submission-envelope.json');
    const envelope = readJson(envelopePath);
    envelope.payloadHashes['candidate-inventory.json'] = smoke.sha256File(candidatePath);
    envelope.payloadHashes['claims.json'] = smoke.sha256File(claimsPath);
    Object.assign(envelope.source, claims.candidateInventory);
    writeJson(envelopePath, envelope);
    const receipt = readJson(fixture.campaignReceiptPath);
    receipt.candidateInventory = structuredClone(claims.candidateInventory);
    receipt.campaign.submissionEnvelopeSha256 = smoke.sha256File(envelopePath);
    writeJson(fixture.campaignReceiptPath, receipt);
}

async function loadClosureFixtureFactory() {
    const testUrl = new URL('./public-smoke-v2-closure.test.js', import.meta.url);
    const replacements = new Map([
        ["import * as smoke from '../../scripts/public-smoke-v2-lib.mjs';", `import * as smoke from ${JSON.stringify(new URL('../../scripts/public-smoke-v2-lib.mjs', import.meta.url).href)};`],
        ["const contractTestUrl = new URL('./public-smoke-v2-contract.test.js', import.meta.url);", `const contractTestUrl = new URL(${JSON.stringify(new URL('./public-smoke-v2-contract.test.js', import.meta.url).href)});`],
        ["const smokeLibraryUrl = new URL('../../scripts/public-smoke-v2-lib.mjs', import.meta.url).href;", `const smokeLibraryUrl = ${JSON.stringify(new URL('../../scripts/public-smoke-v2-lib.mjs', import.meta.url).href)};`],
    ]);
    let source = fs.readFileSync(testUrl, 'utf8').replace("import test from 'node:test';", 'const test = () => {};');
    for (const [from, to] of replacements) source = source.replaceAll(from, to);
    source += '\nexport { makeClosureFixture, localOnlyOverrides };\n';
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const closureFixturePromise = loadClosureFixtureFactory();

function createChromeEvidence(fixture) {
    const closureReceipt = readJson(fixture.config.closureReceiptPath);
    const chromeRoot = path.join(fixture.releaseRoot, 'actual-chrome');
    fs.mkdirSync(chromeRoot, { recursive: true });
    const sourcePng = path.join(fixture.acceptedDir, fixture.cases[0].screenshots[0].relativePath);
    const zoomPath = path.join(chromeRoot, 'actual-chrome-200.png');
    const restorePath = path.join(chromeRoot, 'actual-chrome-restored-100.png');
    fs.copyFileSync(sourcePng, zoomPath);
    fs.copyFileSync(sourcePng, restorePath);
    const recordPath = path.join(chromeRoot, 'capture-record.json');
    writeJson(recordPath, { schemaVersion: 1, sessionId: 'fixture-chrome-session', captureKind: 'computer-use' });
    const afterClosure = new Date(Date.parse(closureReceipt.createdUtc) + 1_000).toISOString();
    const restored = new Date(Date.parse(closureReceipt.createdUtc) + 2_000).toISOString();
    const visibleChecks = { chromeZoomMenu: true, heading: true, signatureRoast: true, quoteCounter: true, npc: true, ending: true };
    const evidence = {
        schemaVersion: 1,
        releaseId: fixture.config.releaseId,
        createdUtc: new Date(Date.parse(closureReceipt.createdUtc) + 3_000).toISOString(),
        captureAuthority: { kind: 'computer-use', sessionId: 'fixture-chrome-session', recordPath, recordSha256: smoke.sha256File(recordPath) },
        browser: { name: 'Google Chrome', version: '140.0.7339.80', executablePath: path.join(chromeRoot, 'chrome.exe') },
        deployment: { deploymentId: fixture.operationReceipt.cloudflareReads.pre.deploymentId, immutableUrl: fixture.config.immutableUrl, aliasUrl: fixture.config.aliasUrl },
        zoom200: { observedUtc: afterClosure, zoomPercent: 200, url: fixture.config.aliasUrl, screenshotPath: zoomPath, screenshotSha256: smoke.sha256File(zoomPath), visibleChecks: structuredClone(visibleChecks) },
        restore100: { observedUtc: restored, zoomPercent: 100, url: fixture.config.aliasUrl, screenshotPath: restorePath, screenshotSha256: smoke.sha256File(restorePath), visibleChecks: structuredClone(visibleChecks) },
    };
    writeJson(fixture.config.actualChromeEvidencePath, evidence);
    return evidence;
}

async function makeFinalizerFixture(t) {
    const { makeClosureFixture, localOnlyOverrides } = await closureFixturePromise;
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    const fixture = await makeClosureFixture(t);
    bindFinalizerIntoCampaign(fixture);
    const local = localOnlyOverrides(fixture);
    await closure.runClosureFromConfig(fixture.configPath, local.overrides);
    const chrome = createChromeEvidence(fixture);
    return { ...fixture, chrome };
}

function resealAcceptedManifest(fixture) {
    const files = [];
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(absolute);
            else {
                const relative = path.relative(fixture.acceptedDir, absolute).split(path.sep).join('/');
                if (relative !== 'artifact-manifest.json') {
                    const bytes = fs.readFileSync(absolute);
                    files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
                }
            }
        }
    }
    walk(fixture.acceptedDir);
    files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    const manifest = { schemaVersion: 1, releaseId: fixture.config.releaseId, files };
    manifest.manifestPayloadSha256 = sha(smoke.canonicalJson(manifest));
    writeJson(path.join(fixture.acceptedDir, 'artifact-manifest.json'), manifest);
    return manifest;
}

function rethreadReceipts(fixture) {
    const manifestPath = path.join(fixture.acceptedDir, 'artifact-manifest.json');
    const eventsPath = path.join(fixture.acceptedDir, 'runner-events.jsonl');
    const manifest = readJson(manifestPath);
    const events = fs.readFileSync(eventsPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
    const operation = readJson(fixture.operationReceiptPath);
    operation.accepted.manifestSha256 = smoke.sha256File(manifestPath);
    operation.accepted.treeDigest = sha(smoke.canonicalJson({ files: manifest.files, manifestSha256: operation.accepted.manifestSha256 }));
    operation.accepted.eventsSha256 = smoke.sha256File(eventsPath);
    operation.accepted.finalEventSha256 = events.at(-1).eventSha256;
    writeJson(fixture.operationReceiptPath, operation);
    const audit = readJson(fixture.config.auditReceiptPath);
    audit.operationReceiptSha256 = smoke.sha256File(fixture.operationReceiptPath);
    audit.acceptedManifestSha256 = operation.accepted.manifestSha256;
    audit.eventsSha256 = operation.accepted.eventsSha256;
    audit.finalEventSha256 = operation.accepted.finalEventSha256;
    writeJson(fixture.config.auditReceiptPath, audit);
    const negative = readJson(fixture.config.negativeReceiptPath);
    negative.operationReceiptSha256 = smoke.sha256File(fixture.operationReceiptPath);
    negative.pristineManifestSha256 = operation.accepted.manifestSha256;
    negative.pristineTreeDigest = operation.accepted.treeDigest;
    negative.checkpoints.forEach((checkpoint) => { checkpoint.treeDigest = operation.accepted.treeDigest; });
    writeJson(fixture.config.negativeReceiptPath, negative);
    const closure = readJson(fixture.config.closureReceiptPath);
    closure.operationReceiptSha256 = smoke.sha256File(fixture.operationReceiptPath);
    closure.auditReceiptSha256 = smoke.sha256File(fixture.config.auditReceiptPath);
    closure.negativeReceiptSha256 = smoke.sha256File(fixture.config.negativeReceiptPath);
    closure.acceptedManifestSha256 = operation.accepted.manifestSha256;
    writeJson(fixture.config.closureReceiptPath, closure);
}

function assertNoPublication(fixture) {
    assert.equal(fs.existsSync(fixture.config.releaseReceiptPath), false);
}

function objectPaths(root) {
    const result = [];
    const seen = new Set();
    function walk(value, parts) {
        if (Array.isArray(value)) { if (value.length) walk(value[0], [...parts, 0]); return; }
        if (!value || typeof value !== 'object') return;
        const shape = Object.keys(value).sort().join('|');
        if (!seen.has(shape)) { seen.add(shape); result.push(parts); }
        for (const [key, child] of Object.entries(value)) walk(child, [...parts, key]);
    }
    walk(root, []);
    return result;
}

function getAt(root, parts) {
    return parts.reduce((value, key) => value[key], root);
}

function wrongType(value) {
    if (Array.isArray(value)) return {};
    if (value === null) return 'signal';
    if (typeof value === 'string') return 7;
    if (typeof value === 'number') return '7';
    if (typeof value === 'boolean') return 1;
    return [];
}

function assertRecursiveExact(validator, valid, name) {
    for (const parts of objectPaths(valid)) {
        const original = getAt(valid, parts);
        const unknown = structuredClone(valid);
        getAt(unknown, parts).__unknown = true;
        assert.throws(() => validator(unknown), undefined, `${name} unknown ${parts.join('.')}`);
        for (const key of Object.keys(original)) {
            const missing = structuredClone(valid);
            delete getAt(missing, parts)[key];
            assert.throws(() => validator(missing), undefined, `${name} missing ${[...parts, key].join('.')}`);
            const typed = structuredClone(valid);
            getAt(typed, parts)[key] = wrongType(original[key]);
            assert.throws(() => validator(typed), undefined, `${name} type ${[...parts, key].join('.')}`);
        }
    }
}

test('finalizer exposes the one-shot config and argv interfaces', () => {
    assert.equal(typeof finalizer.runFinalizerFromConfig, 'function');
    assert.equal(typeof finalizer.runFinalizerFromArgv, 'function');
    assert.equal(typeof smoke.validateActualChromeEvidence, 'function');
    assert.equal(typeof smoke.validateFinalReceipt, 'function');
});

test('valid frozen inputs publish the exact schema-1 receipt without changing any input', async (t) => {
    const fixture = await makeFinalizerFixture(t);
    const protectedPaths = [fixture.configPath, fixture.operationReceiptPath, fixture.config.auditReceiptPath, fixture.config.negativeReceiptPath, fixture.config.closureReceiptPath, fixture.config.actualChromeEvidencePath, path.join(fixture.acceptedDir, 'artifact-manifest.json'), path.join(fixture.acceptedDir, 'runner-events.jsonl')];
    const before = protectedPaths.map((file) => smoke.sha256File(file));
    const receipt = await finalizer.runFinalizerFromConfig(fixture.configPath);
    assert.deepEqual(Object.keys(receipt), FINAL_KEYS);
    assert.equal(receipt.status, 'COMPLETE');
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.config.releaseReceiptPath, 'utf8')), receipt);
    assert.deepEqual(protectedPaths.map((file) => smoke.sha256File(file)), before);
    assert.doesNotThrow(() => smoke.validateFinalReceipt(receipt));
});

test('Actual Chrome and final receipt schemas reject missing, unknown and wrong-type fields recursively', async (t) => {
    const fixture = await makeFinalizerFixture(t);
    const chrome = readJson(fixture.config.actualChromeEvidencePath);
    assertRecursiveExact((value) => smoke.validateActualChromeEvidence(value, {
        releaseId: fixture.config.releaseId,
        deploymentId: fixture.operationReceipt.cloudflareReads.pre.deploymentId,
        immutableUrl: fixture.config.immutableUrl,
        aliasUrl: fixture.config.aliasUrl,
        closureCreatedUtc: readJson(fixture.config.closureReceiptPath).createdUtc,
    }), chrome, 'actualChrome');
    const receipt = await finalizer.runFinalizerFromConfig(fixture.configPath);
    assertRecursiveExact(smoke.validateFinalReceipt, receipt, 'finalReceipt');
});

test('Chrome identity, deployment, zoom, visibility, order, screenshot and capture bindings fail closed', async (t) => {
    const mutations = [
        ['browser name', (value) => { value.browser.name = 'Chromium'; }, /actualChrome\.browser\.name/],
        ['deployment', (value) => { value.deployment.deploymentId = 'other-deployment'; }, /actualChrome\.deployment/],
        ['URL', (value) => { value.zoom200.url = value.deployment.immutableUrl; }, /actualChrome\.zoom200\.url/],
        ['zoom 200', (value) => { value.zoom200.zoomPercent = 199; }, /actualChrome\.zoom200\.zoomPercent/],
        ['restore 100', (value) => { value.restore100.zoomPercent = 101; }, /actualChrome\.restore100\.zoomPercent/],
        ['visible check', (value) => { value.zoom200.visibleChecks.ending = false; }, /actualChrome\.zoom200\.visibleChecks/],
        ['closure order', (value, fixture) => { value.zoom200.observedUtc = readJson(fixture.config.closureReceiptPath).createdUtc; }, /actualChrome\.zoom200\.order/],
        ['restore order', (value) => { value.restore100.observedUtc = value.zoom200.observedUtc; }, /actualChrome\.restore100\.order/],
        ['screenshot hash', (value) => { value.zoom200.screenshotSha256 = '0'.repeat(64); }, /actualChrome\.zoom200\.screenshotSha256/],
        ['capture hash', (value) => { value.captureAuthority.recordSha256 = '0'.repeat(64); }, /actualChrome\.captureAuthority\.recordSha256/],
    ];
    for (const [name, mutate, invariant] of mutations) {
        await t.test(name, async (t) => {
            const fixture = await makeFinalizerFixture(t);
            const changed = readJson(fixture.config.actualChromeEvidencePath);
            mutate(changed, fixture);
            writeJson(fixture.config.actualChromeEvidencePath, changed);
            await assert.rejects(finalizer.runFinalizerFromConfig(fixture.configPath), invariant);
            assertNoPublication(fixture);
        });
    }
});

test('full-rehash semantic mutations reach operation, audit, negative, closure, manifest and event invariants', async (t) => {
    const attacks = [
        ['operation', (fixture) => { const value = readJson(fixture.operationReceiptPath); value.status = 'PARTIAL'; writeJson(fixture.operationReceiptPath, value); }, /operationReceipt\.status/],
        ['audit', (fixture) => { const value = readJson(fixture.config.auditReceiptPath); value.passedCases = 5; writeJson(fixture.config.auditReceiptPath, value); }, /auditReceipt\.summary/],
        ['negative', (fixture) => { const value = readJson(fixture.config.negativeReceiptPath); value.controls[0].observedInvariant = 'stale.hash'; writeJson(fixture.config.negativeReceiptPath, value); }, /negativeReceipt\.control\.observedInvariant/],
        ['closure', (fixture) => { const value = readJson(fixture.config.closureReceiptPath); value.status = 'PARTIAL'; writeJson(fixture.config.closureReceiptPath, value); }, /closureReceipt\.status/],
        ['accepted manifest member', (fixture) => { const acceptedPath = path.join(fixture.acceptedDir, 'accepted-run.json'); const value = readJson(acceptedPath); value.attemptsPerCase = 2; writeJson(acceptedPath, value); resealAcceptedManifest(fixture); }, /acceptedRun\.summary/],
        ['event semantic', (fixture) => { const eventPath = path.join(fixture.acceptedDir, 'runner-events.jsonl'); const events = fs.readFileSync(eventPath, 'utf8').trimEnd().split('\n').map(JSON.parse); const last = events.at(-1); last.payload.caseCount = 5; last.eventSha256 = sha(smoke.canonicalJson({ seq: last.seq, previousEventSha256: last.previousEventSha256, utc: last.utc, monotonicMs: last.monotonicMs, type: last.type, case: last.case, payload: last.payload })); fs.writeFileSync(eventPath, `${events.map(JSON.stringify).join('\n')}\n`); resealAcceptedManifest(fixture); }, /events\.operationFinish\.payload/],
    ];
    for (const [name, mutate, invariant] of attacks) {
        await t.test(name, async (t) => {
            const fixture = await makeFinalizerFixture(t);
            mutate(fixture);
            rethreadReceipts(fixture);
            await assert.rejects(finalizer.runFinalizerFromConfig(fixture.configPath), invariant);
            assertNoPublication(fixture);
        });
    }
});

test('closure product-body drift is rejected after the body, probe and downstream receipt hashes are resealed', async (t) => {
    const fixture = await makeFinalizerFixture(t);
    const closure = readJson(fixture.config.closureReceiptPath);
    const bodyPath = path.join(fixture.config.closureRoot, closure.finalAliasProbe.bodyPaths[0]);
    fs.writeFileSync(bodyPath, 'changed body');
    closure.finalAliasProbe.bodySha256s[0] = smoke.sha256File(bodyPath);
    const probePath = path.join(fixture.config.closureRoot, closure.finalAliasProbe.receiptPath);
    const probe = readJson(probePath);
    probe.results[0].bytes = fs.statSync(bodyPath).size;
    probe.results[0].sha256 = smoke.sha256File(bodyPath);
    writeJson(probePath, probe);
    closure.finalAliasProbe.receiptSha256 = smoke.sha256File(probePath);
    writeJson(fixture.config.closureReceiptPath, closure);
    await assert.rejects(finalizer.runFinalizerFromConfig(fixture.configPath), /closureReceipt\.finalAliasProbe\.bodyAuthority/);
    assertNoPublication(fixture);
});

test('pre-existing and symlink final receipt paths are preserved and never replaced', async (t) => {
    await t.test('pre-existing regular file', async (t) => {
        const fixture = await makeFinalizerFixture(t);
        fs.writeFileSync(fixture.config.releaseReceiptPath, 'foreign');
        await assert.rejects(finalizer.runFinalizerFromConfig(fixture.configPath), /releaseReceiptPath\.exists/);
        assert.equal(fs.readFileSync(fixture.config.releaseReceiptPath, 'utf8'), 'foreign');
    });
    await t.test('symlink target', async (t) => {
        const fixture = await makeFinalizerFixture(t);
        const foreign = path.join(fixture.releaseRoot, 'foreign-final.json');
        fs.writeFileSync(foreign, 'foreign');
        fs.symlinkSync(foreign, fixture.config.releaseReceiptPath, 'file');
        await assert.rejects(finalizer.runFinalizerFromConfig(fixture.configPath), /symlink/);
        assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign');
    });
});

test('input mutation between validation and publication fails without a receipt', async (t) => {
    const fixture = await makeFinalizerFixture(t);
    await assert.rejects(finalizer.runFinalizerFromConfig(fixture.configPath, {
        beforePublication() { fs.appendFileSync(fixture.config.actualChromeEvidencePath, ' '); },
    }), /finalizer\.inputDrift/);
    assertNoPublication(fixture);
});

test('a byte-identical pre-publication collision is never mistaken for the finalizer own link', async (t) => {
    const fixture = await makeFinalizerFixture(t);
    const originalLink = fs.linkSync;
    let expectedBytes;
    fs.linkSync = function (source, destination) {
        expectedBytes = fs.readFileSync(source);
        fs.writeFileSync(destination, expectedBytes);
        return originalLink.call(this, source, destination);
    };
    try {
        await assert.rejects(finalizer.runFinalizerFromConfig(fixture.configPath), /RELEASE_ID_CONSUMED:.*EEXIST/);
    } finally {
        fs.linkSync = originalLink;
    }
    assert.deepEqual(fs.readFileSync(fixture.config.releaseReceiptPath), expectedBytes);
    await assert.rejects(finalizer.runFinalizerFromConfig(fixture.configPath), /RELEASE_ID_CONSUMED/);
    assert.deepEqual(fs.readFileSync(fixture.config.releaseReceiptPath), expectedBytes);
});

test('publication follows FAILURE_ABSENT, PUBLICATION_INDETERMINATE, and COMPLETE states', async (t) => {
    await t.test('pre-link failure is FAILURE_ABSENT and permits a later attempt', async (t) => {
        const fixture = await makeFinalizerFixture(t);
        const originalLink = fs.linkSync;
        fs.linkSync = function () {
            throw new Error('pre-link-failure');
        };
        try {
            await assert.rejects(finalizer.runFinalizerFromConfig(fixture.configPath), /FAILURE_ABSENT: pre-link-failure/);
        } finally {
            fs.linkSync = originalLink;
        }
        assert.equal(fs.existsSync(fixture.config.releaseReceiptPath), false);
        const receipt = await finalizer.runFinalizerFromConfig(fixture.configPath);
        assert.equal(receipt.status, 'COMPLETE');
    });

    await t.test('post-link parent fsync failure is indeterminate and consumes the release ID', async (t) => {
        const fixture = await makeFinalizerFixture(t);
        const originalFsync = fs.fsyncSync;
        fs.fsyncSync = function (descriptor) {
            const stat = fs.fstatSync(descriptor);
            if (stat.isDirectory()) throw new Error('publication-parent-fsync-failure');
            return originalFsync.call(this, descriptor);
        };
        try {
            await assert.rejects(finalizer.runFinalizerFromConfig(fixture.configPath), /PUBLICATION_INDETERMINATE: publication-parent-fsync-failure/);
        } finally {
            fs.fsyncSync = originalFsync;
        }
        const receiptBytes = fs.readFileSync(fixture.config.releaseReceiptPath);
        await assert.rejects(finalizer.runFinalizerFromConfig(fixture.configPath), /RELEASE_ID_CONSUMED/);
        assert.deepEqual(fs.readFileSync(fixture.config.releaseReceiptPath), receiptBytes);
    });

    await t.test('temporary unlink failure is indeterminate and preserves the final pathname', async (t) => {
        const fixture = await makeFinalizerFixture(t);
        const originalUnlink = fs.unlinkSync;
        let injected = false;
        fs.unlinkSync = function (target) {
            if (!injected && path.basename(target).startsWith(`.${path.basename(fixture.config.releaseReceiptPath)}.tmp-`)) {
                injected = true;
                throw new Error('temp-unlink-failure');
            }
            return originalUnlink.call(this, target);
        };
        try {
            await assert.rejects(finalizer.runFinalizerFromConfig(fixture.configPath), /PUBLICATION_INDETERMINATE: temp-unlink-failure/);
        } finally {
            fs.unlinkSync = originalUnlink;
        }
        assert.equal(readJson(fixture.config.releaseReceiptPath).status, 'COMPLETE');
    });

    await t.test('post-publication input drift is indeterminate and preserves the final pathname', async (t) => {
        const fixture = await makeFinalizerFixture(t);
        const originalLink = fs.linkSync;
        fs.linkSync = function (source, destination) {
            originalLink.call(this, source, destination);
            fs.appendFileSync(fixture.config.actualChromeEvidencePath, ' ');
        };
        try {
            await assert.rejects(finalizer.runFinalizerFromConfig(fixture.configPath), /PUBLICATION_INDETERMINATE: finalizer\.inputDrift/);
        } finally {
            fs.linkSync = originalLink;
        }
        assert.equal(readJson(fixture.config.releaseReceiptPath).status, 'COMPLETE');
    });

    await t.test('post-link final receipt validation uncertainty is indeterminate and preserves the pathname', async (t) => {
        const fixture = await makeFinalizerFixture(t);
        const originalUnlink = fs.unlinkSync;
        fs.unlinkSync = function (target) {
            if (path.basename(target).startsWith(`.${path.basename(fixture.config.releaseReceiptPath)}.tmp-`)) {
                originalUnlink.call(this, target);
                originalUnlink.call(this, fixture.config.releaseReceiptPath);
                fs.writeFileSync(fixture.config.releaseReceiptPath, '{}\n');
                return;
            }
            return originalUnlink.call(this, target);
        };
        try {
            await assert.rejects(finalizer.runFinalizerFromConfig(fixture.configPath), /PUBLICATION_INDETERMINATE: finalReceipt/);
        } finally {
            fs.unlinkSync = originalUnlink;
        }
        assert.equal(fs.readFileSync(fixture.config.releaseReceiptPath, 'utf8'), '{}\n');
    });

    await t.test('unlink-boundary same-byte new-inode replacement is never conditionally removed post-link', async (t) => {
        const fixture = await makeFinalizerFixture(t);
        const originalLstat = fs.lstatSync;
        const originalFsync = fs.fsyncSync;
        const originalUnlink = fs.unlinkSync;
        let linkedIdentity;
        let replacementBytes;
        let finalUnlinkEntered = false;
        fs.lstatSync = function (target, ...args) {
            if (linkedIdentity && path.resolve(target) === path.resolve(fixture.config.releaseReceiptPath)) return linkedIdentity;
            return originalLstat.call(this, target, ...args);
        };
        fs.fsyncSync = function (descriptor) {
            if (fs.fstatSync(descriptor).isDirectory()) {
                linkedIdentity = originalLstat(fixture.config.releaseReceiptPath);
                replacementBytes = fs.readFileSync(fixture.config.releaseReceiptPath);
                originalUnlink(fixture.config.releaseReceiptPath);
                fs.writeFileSync(fixture.config.releaseReceiptPath, replacementBytes);
                throw new Error('publication-parent-fsync-failure');
            }
            return originalFsync.call(this, descriptor);
        };
        fs.unlinkSync = function (target) {
            if (path.resolve(target) === path.resolve(fixture.config.releaseReceiptPath)) {
                finalUnlinkEntered = true;
                originalUnlink.call(this, target);
                fs.writeFileSync(target, replacementBytes);
            }
            return originalUnlink.call(this, target);
        };
        try {
            await assert.rejects(finalizer.runFinalizerFromConfig(fixture.configPath), /PUBLICATION_INDETERMINATE: publication-parent-fsync-failure/);
        } finally {
            fs.lstatSync = originalLstat;
            fs.fsyncSync = originalFsync;
            fs.unlinkSync = originalUnlink;
        }
        assert.equal(finalUnlinkEntered, false);
        assert.deepEqual(fs.readFileSync(fixture.config.releaseReceiptPath), replacementBytes);
    });
});

test('argv is exact and the real CLI emits one strict success line with empty stderr', async (t) => {
    const fixture = await makeFinalizerFixture(t);
    await assert.rejects(finalizer.runFinalizerFromArgv([]), /finalizer\.argv/);
    await assert.rejects(finalizer.runFinalizerFromArgv(['--config', fixture.configPath, '--config', fixture.configPath]), /finalizer\.argv/);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/finalize-public-smoke-v2.mjs', import.meta.url)), '--config', fixture.configPath], { encoding: null, windowsHide: true });
    assert.equal(result.status, 0, result.stderr.toString('utf8'));
    assert.deepEqual(result.stdout, Buffer.from('PUBLIC_SMOKE_V2_RELEASE=COMPLETE\n'));
    assert.deepEqual(result.stderr, Buffer.alloc(0));
    assert.equal(readJson(fixture.config.releaseReceiptPath).status, 'COMPLETE');

    const consumed = await makeFinalizerFixture(t);
    fs.writeFileSync(consumed.config.releaseReceiptPath, 'occupied release identity');
    const rejected = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/finalize-public-smoke-v2.mjs', import.meta.url)), '--config', consumed.configPath], { encoding: null, windowsHide: true });
    assert.notEqual(rejected.status, 0);
    assert.deepEqual(rejected.stdout, Buffer.alloc(0));
    assert.match(rejected.stderr.toString('utf8'), /^RELEASE_ID_CONSUMED:/);
    assert.equal(fs.readFileSync(consumed.config.releaseReceiptPath, 'utf8'), 'occupied release identity');
});
