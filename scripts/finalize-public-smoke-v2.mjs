import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    auditAcceptedRun,
    canonicalJson,
    loadOperationAuthority,
    sha256File,
    validateActualChromeEvidence,
    validateAuditReceipt,
    validateClosureReceipt,
    validateExecutedSnapshotBinding,
    validateFinalReceipt,
    validateNegativeReceipt,
    validateOperationConfig,
    validateOperationReceipt,
} from './public-smoke-v2-lib.mjs';

const FINALIZER_PATH = fileURLToPath(import.meta.url);
const PUBLIC_PATHS = Object.freeze(['/', '/content.js', '/game-core.js', '/script.js', '/style.css']);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fail(invariant, detail = '') {
    throw new Error(`${invariant}${detail ? `: ${detail}` : ''}`);
}

function readJson(file, invariant) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { fail(invariant, error.message); }
}

function pathExists(file) {
    try { fs.lstatSync(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function requireNoSymlinkAncestors(target, invariant) {
    let cursor = path.resolve(target);
    while (true) {
        if (pathExists(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail(invariant, `symlink=${cursor}`);
        const parent = path.dirname(cursor);
        if (parent === cursor) return;
        cursor = parent;
    }
}

function requireRegular(file, invariant) {
    requireNoSymlinkAncestors(file, `${invariant}.symlink`);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { fail(invariant, error.message); }
    if (!stat.isFile() || stat.isSymbolicLink()) fail(invariant, 'must be a regular non-symlink file');
    return path.resolve(file);
}

function contained(root, file, invariant) {
    const base = path.resolve(root);
    const target = path.resolve(file);
    if (target === base || !target.startsWith(`${base}${path.sep}`)) fail(invariant, 'escapes root');
    return target;
}

function collectFiles(root, result, excluded = new Set()) {
    requireNoSymlinkAncestors(root, 'finalizer.input.symlink');
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink()) fail('finalizer.input.symlink');
    if (stat.isFile()) {
        const absolute = path.resolve(root);
        if (!excluded.has(absolute)) result.add(absolute);
        return;
    }
    if (!stat.isDirectory()) fail('finalizer.input.type');
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const absolute = path.join(root, entry.name);
        if (excluded.has(path.resolve(absolute))) continue;
        if (entry.isSymbolicLink()) fail('finalizer.input.symlink', absolute);
        if (entry.isDirectory()) collectFiles(absolute, result, excluded);
        else if (entry.isFile()) result.add(path.resolve(absolute));
        else fail('finalizer.input.type', absolute);
    }
}

function snapshotInputs(config) {
    const files = new Set();
    const excluded = new Set([path.resolve(config.releaseReceiptPath)]);
    for (const root of [config.releaseRoot, config.campaignDir, config.executionSourceDir]) collectFiles(root, files, excluded);
    for (const file of [config.campaignSpecPath, config.campaignReceiptPath, config.nodeExePath, config.wranglerJsPath, FINALIZER_PATH]) files.add(requireRegular(file, 'finalizer.input.file'));
    return new Map([...files].sort((left, right) => left.localeCompare(right, 'en')).map((file) => [file, sha256File(file)]));
}

function requireSameSnapshot(before, config) {
    const after = snapshotInputs(config);
    if (before.size !== after.size) fail('finalizer.inputDrift');
    for (const [file, digest] of before) if (after.get(file) !== digest) fail('finalizer.inputDrift', file);
}

function validateClosureFiles(config, closure, productFiles) {
    const root = path.resolve(config.closureRoot);
    const ownership = closure.ownershipRead;
    for (const [kind, relative, bytes, digest] of [
        ['stdout', ownership.stdoutPath, ownership.stdoutBytes, ownership.stdoutSha256],
        ['stderr', ownership.stderrPath, ownership.stderrBytes, ownership.stderrSha256],
    ]) {
        const file = requireRegular(contained(root, path.join(root, ...relative.split('/')), `closureReceipt.ownershipRead.${kind}Path`), `closureReceipt.ownershipRead.${kind}Path`);
        if (fs.statSync(file).size !== bytes || sha256File(file) !== digest) fail(`closureReceipt.ownershipRead.${kind}Binding`);
    }
    const probePath = requireRegular(contained(root, path.join(root, ...closure.finalAliasProbe.receiptPath.split('/')), 'closureReceipt.finalAliasProbe.receiptPath'), 'closureReceipt.finalAliasProbe.receiptPath');
    if (sha256File(probePath) !== closure.finalAliasProbe.receiptSha256) fail('closureReceipt.finalAliasProbe.receiptSha256');
    const probe = readJson(probePath, 'closureReceipt.finalAliasProbe.receipt');
    if (!Array.isArray(probe.results) || probe.results.length !== 5 || probe.passed !== 5 || probe.total !== 5) fail('closureReceipt.finalAliasProbe.receiptGate');
    closure.finalAliasProbe.bodyPaths.forEach((relative, index) => {
        const file = requireRegular(contained(root, path.join(root, ...relative.split('/')), 'closureReceipt.finalAliasProbe.bodyPath'), 'closureReceipt.finalAliasProbe.bodyPath');
        const authority = productFiles[PUBLIC_PATHS[index]];
        const result = probe.results[index];
        if (sha256File(file) !== closure.finalAliasProbe.bodySha256s[index] || fs.statSync(file).size !== authority.bytes || sha256File(file) !== authority.sha256 || result.bodyPath !== relative || result.bytes !== authority.bytes || result.mime !== authority.mime || result.sha256 !== authority.sha256) fail('closureReceipt.finalAliasProbe.bodyAuthority');
    });
}

function validateChromeFiles(config, chrome) {
    for (const [key, file, digest] of [
        ['captureAuthority', chrome.captureAuthority.recordPath, chrome.captureAuthority.recordSha256],
        ['zoom200', chrome.zoom200.screenshotPath, chrome.zoom200.screenshotSha256],
        ['restore100', chrome.restore100.screenshotPath, chrome.restore100.screenshotSha256],
    ]) {
        const canonical = requireRegular(contained(config.releaseRoot, file, `actualChrome.${key}.containment`), `actualChrome.${key}`);
        if (sha256File(canonical) !== digest) fail(`actualChrome.${key}.${key === 'captureAuthority' ? 'recordSha256' : 'screenshotSha256'}`);
        if (key !== 'captureAuthority') {
            const signature = fs.readFileSync(canonical).subarray(0, PNG_SIGNATURE.length);
            if (!signature.equals(PNG_SIGNATURE)) fail(`actualChrome.${key}.screenshotPng`);
        }
    }
}

function fsyncDirectory(directory) {
    let descriptor;
    try {
        descriptor = fs.openSync(directory, 'r');
        fs.fsyncSync(descriptor);
    } catch (error) {
        if (!(process.platform === 'win32' && error.code === 'EPERM')) throw error;
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

function publishExclusive(file, receipt) {
    const parent = path.dirname(file);
    fs.mkdirSync(parent, { recursive: true });
    const temporary = path.join(parent, `.${path.basename(file)}.tmp-${crypto.randomBytes(16).toString('hex')}`);
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, 'wx');
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    let linked = false;
    try {
        fs.linkSync(temporary, file);
        linked = true;
        fsyncDirectory(parent);
    } catch (error) {
        if (linked && pathExists(file) && sha256File(file) === crypto.createHash('sha256').update(bytes).digest('hex')) fs.unlinkSync(file);
        throw error;
    } finally {
        if (pathExists(temporary)) fs.unlinkSync(temporary);
    }
}

function sameExceptCreated(actual, expected, invariant) {
    if (canonicalJson({ ...actual, createdUtc: expected.createdUtc }) !== canonicalJson(expected)) fail(invariant);
}

export async function runFinalizerFromConfig(configPath, dependencies = {}) {
    const canonicalConfigPath = path.resolve(configPath);
    if (!path.isAbsolute(configPath) || canonicalConfigPath !== configPath) fail('config.path');
    requireRegular(canonicalConfigPath, 'config.path');
    const config = validateOperationConfig(readJson(canonicalConfigPath, 'finalizer.config'));
    if (pathExists(config.releaseReceiptPath)) {
        if (fs.lstatSync(config.releaseReceiptPath).isSymbolicLink()) fail('releaseReceiptPath.symlink');
        fail('releaseReceiptPath.exists');
    }
    requireNoSymlinkAncestors(config.releaseReceiptPath, 'releaseReceiptPath.symlink');
    const before = snapshotInputs(config);
    const sourceFinalizerPath = path.join(config.sourceSnapshotDir, 'scripts', 'finalize-public-smoke-v2.mjs');
    validateExecutedSnapshotBinding(FINALIZER_PATH, sourceFinalizerPath);
    const authority = loadOperationAuthority(config);
    const operation = validateOperationReceipt(readJson(config.operationReceiptPath, 'operationReceipt.json'));
    const derivedAudit = auditAcceptedRun({ configPath: canonicalConfigPath });
    const audit = validateAuditReceipt(readJson(config.auditReceiptPath, 'auditReceipt.json'));
    sameExceptCreated(audit, derivedAudit, 'auditReceipt.binding');
    const negative = validateNegativeReceipt(readJson(config.negativeReceiptPath, 'negativeReceipt.json'), {
        pristineAcceptedRealpath: config.acceptedDir,
        nodeExePath: config.nodeExePath,
        auditorPath: path.join(config.authorityProjectRoot, 'scripts', 'verify-public-smoke-v2.mjs'),
    });
    const closure = validateClosureReceipt(readJson(config.closureReceiptPath, 'closureReceipt.json'), {
        releaseId: config.releaseId,
        configSha256: sha256File(canonicalConfigPath),
        operationReceiptSha256: sha256File(config.operationReceiptPath),
        auditReceiptSha256: sha256File(config.auditReceiptPath),
        negativeReceiptSha256: sha256File(config.negativeReceiptPath),
        acceptedManifestSha256: operation.accepted.manifestSha256,
        deploymentId: authority.deployment.deploymentId,
        sourcePrefix: authority.sourceGitHead.slice(0, 7),
        immutableUrl: config.immutableUrl,
        cwd: config.authorityProjectRoot,
    });
    if (negative.configSha256 !== sha256File(canonicalConfigPath) || negative.operationReceiptSha256 !== sha256File(config.operationReceiptPath) || negative.pristineManifestSha256 !== operation.accepted.manifestSha256 || negative.pristineTreeDigest !== operation.accepted.treeDigest) fail('negativeReceipt.binding');
    validateClosureFiles(config, closure, authority.productFiles);
    const chrome = validateActualChromeEvidence(readJson(config.actualChromeEvidencePath, 'actualChrome.json'), {
        releaseId: config.releaseId,
        deploymentId: authority.deployment.deploymentId,
        immutableUrl: config.immutableUrl,
        aliasUrl: config.aliasUrl,
        closureCreatedUtc: closure.createdUtc,
    });
    validateChromeFiles(config, chrome);
    const receipt = {
        schemaVersion: 1,
        releaseId: config.releaseId,
        status: 'COMPLETE',
        createdUtc: new Date().toISOString(),
        finalizerPath: FINALIZER_PATH,
        finalizerSha256: sha256File(FINALIZER_PATH),
        configSha256: sha256File(canonicalConfigPath),
        campaignVerifierProofSha256: operation.campaignVerifier.stdoutSha256,
        operationReceiptSha256: sha256File(config.operationReceiptPath),
        auditReceiptSha256: sha256File(config.auditReceiptPath),
        negativeReceiptSha256: sha256File(config.negativeReceiptPath),
        closureReceiptSha256: sha256File(config.closureReceiptPath),
        actualChromeEvidencePath: config.actualChromeEvidencePath,
        actualChromeEvidenceSha256: sha256File(config.actualChromeEvidencePath),
        acceptedManifestSha256: operation.accepted.manifestSha256,
        eventsSha256: operation.accepted.eventsSha256,
        finalEventSha256: operation.accepted.finalEventSha256,
        deploymentId: authority.deployment.deploymentId,
        immutableUrl: config.immutableUrl,
        aliasUrl: config.aliasUrl,
        fileGates: { initial: '10/10', operationFinalAlias: '5/5', closureFinalAlias: '5/5' },
        smokeGate: '6/6',
        negativeGate: '12/12',
        screenshotBindings: structuredClone(operation.screenshotBindings),
        actualChrome: { browserName: chrome.browser.name, browserVersion: chrome.browser.version, deploymentId: chrome.deployment.deploymentId, url: chrome.zoom200.url, observed200Utc: chrome.zoom200.observedUtc, restored100Utc: chrome.restore100.observedUtc, zoomObserved: chrome.zoom200.zoomPercent, zoomRestored: chrome.restore100.zoomPercent, evidencePath: config.actualChromeEvidencePath, evidenceSha256: sha256File(config.actualChromeEvidencePath) },
        productFiles: structuredClone(authority.productFiles),
    };
    validateFinalReceipt(receipt, { releaseId: config.releaseId, deploymentId: authority.deployment.deploymentId, immutableUrl: config.immutableUrl, aliasUrl: config.aliasUrl });
    dependencies.beforePublication?.();
    requireSameSnapshot(before, config);
    publishExclusive(config.releaseReceiptPath, receipt);
    try { requireSameSnapshot(before, config); }
    catch (error) { if (pathExists(config.releaseReceiptPath) && sha256File(config.releaseReceiptPath) === crypto.createHash('sha256').update(`${JSON.stringify(receipt)}\n`).digest('hex')) fs.unlinkSync(config.releaseReceiptPath); throw error; }
    return receipt;
}

export async function runFinalizerFromArgv(argv = process.argv.slice(2), dependencies = {}) {
    if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--config' || typeof argv[1] !== 'string' || !path.isAbsolute(argv[1])) fail('finalizer.argv');
    return runFinalizerFromConfig(argv[1], dependencies);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(FINALIZER_PATH)) {
    runFinalizerFromArgv().then(() => process.stdout.write('PUBLIC_SMOKE_V2_RELEASE=COMPLETE\n')).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
