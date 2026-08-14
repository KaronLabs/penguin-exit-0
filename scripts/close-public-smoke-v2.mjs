import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    auditAcceptedRun,
    canonicalJson,
    loadOperationAuthority,
    NEGATIVE_CONTROL_REGISTRY,
    sha256File,
    validateAuditReceipt,
    validateClosureReceipt,
    validateDerivedAuditConfig,
    validateManifest,
    validateNegativeReceipt,
    validateOperationConfig,
    validateOperationReceipt,
    validateWranglerRows,
} from './public-smoke-v2-lib.mjs';

const PUBLIC_PATHS = Object.freeze(['/', '/content.js', '/game-core.js', '/script.js', '/style.css']);
const BODY_TOKENS = Object.freeze(['root', 'content-js', 'game-core-js', 'script-js', 'style-css']);
const OWNERSHIP_TIMEOUT_MS = 120_000;
const SUCCESS_GATE = /(?:^|\r?\n)PUBLIC_SMOKE_V2_(?:GATE|NEGATIVE_CONTROLS|RELEASE)=/;

function fail(invariant, detail = '') {
    throw new Error(`${invariant}${detail ? `: ${detail}` : ''}`);
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(file, invariant) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { fail(invariant, error.message); }
}

function pathEntryExists(file) {
    try { fs.lstatSync(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function requireRegularFile(file, invariant) {
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { fail(invariant, error.message); }
    if (!stat.isFile() || stat.isSymbolicLink()) fail(invariant, 'must be a regular non-symlink file');
    return file;
}

function requireNoSymlinkAncestors(target, invariant) {
    let cursor = path.resolve(target);
    while (true) {
        if (pathEntryExists(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail(invariant, `symlink=${cursor}`);
        const parent = path.dirname(cursor);
        if (parent === cursor) return;
        cursor = parent;
    }
}

function relativeContained(root, file, invariant) {
    const base = path.resolve(root);
    const target = path.resolve(file);
    if (target === base || !target.startsWith(`${base}${path.sep}`)) fail(invariant, 'escapes root');
    requireNoSymlinkAncestors(target, invariant);
    return target;
}

function writeExclusive(file, bytes) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const descriptor = fs.openSync(file, 'wx');
    try {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
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

function walkDirectories(root) {
    const directories = [root];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) directories.push(...walkDirectories(path.join(root, entry.name)));
    }
    return directories;
}

function sealStage(stage) {
    for (const directory of walkDirectories(stage).sort((left, right) => right.length - left.length)) fsyncDirectory(directory);
    fsyncDirectory(path.dirname(stage));
}

function canonicalUrl(base, publicPath) {
    return new URL(publicPath === '/' ? '/' : publicPath.slice(1), base).href;
}

function validateControlEvidence(control, config, configPath, configSha256, operationReceiptSha256) {
    const derivedPath = control.auditorArgv[3];
    requireRegularFile(derivedPath, 'negativeReceipt.control.derivedConfigPath');
    if (sha256File(derivedPath) !== control.derivedConfigSha256) fail('negativeReceipt.control.derivedConfigSha256');
    const derived = validateDerivedAuditConfig(readJson(derivedPath, 'negativeReceipt.control.derivedConfig'));
    if (derived.baseConfigPath !== configPath || derived.baseConfigSha256 !== configSha256 || derived.mutationId !== control.id || derived.mutationRootRealpath !== control.mutationRootRealpath || derived.auditTargetRealpath !== control.targetRealpath || derived.externalOperationReceiptPath !== config.operationReceiptPath || derived.auditReceiptPath !== path.join(control.mutationRootRealpath, 'audit-receipt.json')) fail('negativeReceipt.control.derivedConfigBinding');
    if (pathEntryExists(derived.auditReceiptPath)) fail('negativeReceipt.control.auditReceiptPath');
    const stdoutPath = requireRegularFile(path.join(control.mutationRootRealpath, 'auditor.stdout.bin'), 'negativeReceipt.control.stdoutPath');
    const stderrPath = requireRegularFile(path.join(control.mutationRootRealpath, 'auditor.stderr.bin'), 'negativeReceipt.control.stderrPath');
    const stdout = fs.readFileSync(stdoutPath);
    const stderr = fs.readFileSync(stderrPath);
    if (sha256(stdout) !== control.stdoutSha256 || sha256(stderr) !== control.stderrSha256) fail('negativeReceipt.control.streamSha256');
    const stdoutText = stdout.toString('utf8');
    const stderrText = stderr.toString('utf8');
    if (SUCCESS_GATE.test(stdoutText) || SUCCESS_GATE.test(stderrText)) fail('negativeReceipt.control.successGateAbsent');
    const lines = stderrText.trimEnd().split(/\r?\n/);
    if (lines[0] !== `AUDIT_TARGET_REALPATH=${control.targetRealpath}` || lines[1]?.split(':', 1)[0] !== control.expectedInvariant) fail('negativeReceipt.control.diagnosticBinding');
    if (sha256File(config.operationReceiptPath) !== operationReceiptSha256) fail('negativeReceipt.operationReceiptSha256');
}

function validateOffline(configPath) {
    const config = validateOperationConfig(readJson(configPath, 'closure.config'));
    if (path.resolve(config.closureReceiptPath) !== path.join(path.resolve(config.closureRoot), 'receipt.json')) fail('closureReceiptPath.binding');
    if (pathEntryExists(config.closureRoot)) fail('closureRoot.exists');
    if (pathEntryExists(config.closureReceiptPath)) fail('closureReceiptPath.exists');
    requireNoSymlinkAncestors(config.closureRoot, 'closureRoot.symlink');
    requireNoSymlinkAncestors(config.closureReceiptPath, 'closureReceiptPath.symlink');

    const configSha256 = sha256File(configPath);
    const operationReceiptSha256 = sha256File(config.operationReceiptPath);
    const operation = validateOperationReceipt(readJson(config.operationReceiptPath, 'closure.operationReceipt'));
    const derivedAudit = auditAcceptedRun({ configPath });
    const audit = validateAuditReceipt(readJson(config.auditReceiptPath, 'closure.auditReceipt'), derivedAudit);
    const auditReceiptSha256 = sha256File(config.auditReceiptPath);
    const negative = validateNegativeReceipt(readJson(config.negativeReceiptPath, 'closure.negativeReceipt'), {
        pristineAcceptedRealpath: fs.realpathSync(config.acceptedDir),
        nodeExePath: config.nodeExePath,
        auditorPath: path.join(config.authorityProjectRoot, 'scripts', 'verify-public-smoke-v2.mjs'),
    });
    const negativeReceiptSha256 = sha256File(config.negativeReceiptPath);
    const manifestPath = requireRegularFile(path.join(config.acceptedDir, 'artifact-manifest.json'), 'closure.acceptedManifestPath');
    const manifest = validateManifest(fs.realpathSync(config.acceptedDir), readJson(manifestPath, 'closure.acceptedManifest'));
    const acceptedManifestSha256 = sha256File(manifestPath);
    if (operationReceiptSha256 !== audit.operationReceiptSha256 || operationReceiptSha256 !== negative.operationReceiptSha256) fail('closure.operationReceiptSha256.binding');
    if (configSha256 !== audit.configSha256 || configSha256 !== negative.configSha256) fail('closure.configSha256.binding');
    if (acceptedManifestSha256 !== audit.acceptedManifestSha256 || acceptedManifestSha256 !== negative.pristineManifestSha256 || acceptedManifestSha256 !== operation.accepted.manifestSha256) fail('negativeReceipt.pristineManifestSha256');
    const treeDigest = sha256(Buffer.from(canonicalJson({ files: manifest.files, manifestSha256: acceptedManifestSha256 })));
    if (treeDigest !== operation.accepted.treeDigest || treeDigest !== negative.pristineTreeDigest) fail('negativeReceipt.pristineTreeDigest');
    if (audit.releaseId !== config.releaseId || negative.releaseId !== config.releaseId || operation.releaseId !== config.releaseId) fail('closure.releaseId.binding');
    if (audit.deploymentId !== operation.cloudflareReads.pre.deploymentId) fail('closure.audit.deploymentId');
    negative.controls.forEach((control) => validateControlEvidence(control, config, configPath, configSha256, operationReceiptSha256));
    const authority = loadOperationAuthority(config);
    return { config, configSha256, operation, operationReceiptSha256, auditReceiptSha256, negativeReceiptSha256, acceptedManifestSha256, authority };
}

function ownershipArgv(config) {
    return [config.nodeExePath, config.wranglerJsPath, 'pages', 'deployment', 'list', '--project-name', config.projectName, '--environment', 'production', '--json'];
}

function captureOwnership(stage, offline, deps) {
    const { config, authority } = offline;
    const argv = ownershipArgv(config);
    const startedUtc = deps.now().toISOString();
    const result = deps.spawnSyncImpl(argv[0], argv.slice(1), {
        cwd: config.authorityProjectRoot,
        shell: false,
        encoding: null,
        windowsHide: true,
        timeout: OWNERSHIP_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024,
    });
    const finishedUtc = deps.now().toISOString();
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? '');
    const stdoutPath = 'ownership/stdout.bin';
    const stderrPath = 'ownership/stderr.bin';
    writeExclusive(path.join(stage, ...stdoutPath.split('/')), stdout);
    writeExclusive(path.join(stage, ...stderrPath.split('/')), stderr);
    writeExclusive(path.join(stage, 'ownership', 'command.json'), Buffer.from(`${canonicalJson({ argv, cwd: config.authorityProjectRoot, startedUtc, finishedUtc, exitCode: result.status ?? null, signal: result.signal ?? null })}\n`));
    if (result.error?.code === 'ETIMEDOUT') fail('closure.ownership.timeout');
    if (result.error) fail('closure.ownership.error', result.error.message);
    if (result.signal !== null && result.signal !== undefined) fail('closure.ownership.signal');
    if (result.status !== 0) fail('closure.ownership.exitCode');
    if (stderr.length !== 0) fail('closure.ownership.stderr');
    let rows;
    try { rows = JSON.parse(stdout.toString('utf8')); }
    catch { fail('closure.ownership.stdoutJson'); }
    validateWranglerRows(rows, { deploymentId: authority.deployment.deploymentId, immutableUrl: authority.deployment.immutableUrl, sourceGitHead: authority.sourceGitHead });
    return {
        argv,
        cwd: config.authorityProjectRoot,
        startedUtc,
        finishedUtc,
        exitCode: 0,
        signal: null,
        stdoutPath,
        stdoutBytes: stdout.length,
        stdoutSha256: sha256(stdout),
        stderrPath,
        stderrBytes: stderr.length,
        stderrSha256: sha256(stderr),
        deploymentId: authority.deployment.deploymentId,
        sourcePrefix: authority.sourceGitHead.slice(0, 7),
        immutableUrl: authority.deployment.immutableUrl,
    };
}

async function collectFinalAlias(stage, offline, deps) {
    const { config, authority } = offline;
    const startedUtc = deps.now().toISOString();
    const results = [];
    const bodyPaths = [];
    const bodySha256s = [];
    for (const [index, publicPath] of PUBLIC_PATHS.entries()) {
        const requestedUrl = canonicalUrl(config.aliasUrl, publicPath);
        const requestStartedUtc = deps.now().toISOString();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), deps.requestTimeoutMs);
        let response;
        let body;
        try {
            response = await deps.fetchImpl(requestedUrl, { redirect: 'manual', cache: 'no-store', signal: controller.signal });
            body = Buffer.from(await response.arrayBuffer());
        } catch (error) {
            if (controller.signal.aborted) fail('closure.alias.timeout');
            throw error;
        }
        finally { clearTimeout(timeout); }
        const bodyPath = `file-probes/bodies/closure-alias-${BODY_TOKENS[index]}.bin`;
        writeExclusive(path.join(stage, ...bodyPath.split('/')), body);
        const expected = authority.productFiles[publicPath];
        if (response.url !== requestedUrl) fail('closure.alias.finalUrl');
        if (response.status !== 200) fail('closure.alias.status');
        const contentType = response.headers.get('content-type');
        const mime = typeof contentType === 'string' ? contentType.split(';', 1)[0].trim().toLowerCase() : '';
        if (!mime || mime !== expected.mime) fail('closure.alias.mime');
        const bodySha256 = sha256(body);
        if (body.length !== expected.bytes || bodySha256 !== expected.sha256) fail('closure.alias.sourceBytes');
        const requestFinishedUtc = deps.now().toISOString();
        results.push({ originKind: 'alias', path: publicPath, requestedUrl, finalUrl: response.url, redirects: [], status: response.status, contentType, mime, bodyPath, bytes: body.length, sha256: bodySha256, startedUtc: requestStartedUtc, finishedUtc: requestFinishedUtc, transportError: null });
        bodyPaths.push(bodyPath);
        bodySha256s.push(bodySha256);
    }
    const probe = { schemaVersion: 2, phase: 'closure-final-alias', startedUtc, finishedUtc: deps.now().toISOString(), expectedSourceGitHead: authority.sourceGitHead, expectedDeploymentId: authority.deployment.deploymentId, results, passed: 5, total: 5 };
    const receiptPath = 'file-probes/closure-final-alias-5.json';
    const absolute = path.join(stage, ...receiptPath.split('/'));
    writeExclusive(absolute, Buffer.from(`${canonicalJson(probe)}\n`));
    return { receiptPath, receiptSha256: sha256File(absolute), bodyPaths, bodySha256s, passed: 5, total: 5 };
}

function uniqueSibling(root, prefix, suffix) {
    return path.join(path.dirname(root), `${prefix}${suffix}`);
}

function publishDiagnostic(config, stage, error, deps) {
    const diagnostic = uniqueSibling(config.closureRoot, `${path.basename(config.closureRoot)}-failure-`, `${deps.now().toISOString().replaceAll(/[-:.]/g, '')}-${crypto.randomBytes(16).toString('hex')}`);
    let root = stage;
    if (!root || !pathEntryExists(root)) {
        fs.mkdirSync(diagnostic, { recursive: false });
        root = diagnostic;
    }
    const stagedReceipt = path.join(root, 'receipt.json');
    if (pathEntryExists(stagedReceipt)) fs.unlinkSync(stagedReceipt);
    writeExclusive(path.join(root, 'diagnostic.json'), Buffer.from(`${canonicalJson({ schemaVersion: 1, status: 'FAILED', invariant: error.message, createdUtc: deps.now().toISOString() })}\n`));
    sealStage(root);
    if (root !== diagnostic) {
        fs.renameSync(root, diagnostic);
        fsyncDirectory(path.dirname(diagnostic));
    }
    return diagnostic;
}

export async function runClosureFromConfig(configPath, overrides = {}) {
    if (!path.isAbsolute(configPath)) fail('config.path', 'must be absolute');
    const canonicalConfigPath = path.resolve(configPath);
    const deps = {
        spawnSyncImpl: overrides.spawnSyncImpl ?? spawnSync,
        fetchImpl: overrides.fetchImpl ?? fetch,
        now: overrides.now ?? (() => new Date()),
        randomHex: overrides.randomHex ?? (() => crypto.randomBytes(16).toString('hex')),
        requestTimeoutMs: overrides.requestTimeoutMs ?? OWNERSHIP_TIMEOUT_MS,
    };
    let config;
    let stage;
    let stageOwned = false;
    try {
        config = validateOperationConfig(readJson(canonicalConfigPath, 'closure.config'));
        const offline = validateOffline(canonicalConfigPath);
        const suffix = deps.randomHex();
        if (!/^[a-f0-9]{32}$/.test(suffix)) fail('closure.stage.suffix');
        stage = uniqueSibling(config.closureRoot, `.${path.basename(config.closureRoot)}.stage-`, suffix);
        fs.mkdirSync(stage, { recursive: false });
        stageOwned = true;
        const ownershipRead = captureOwnership(stage, offline, deps);
        const finalAliasProbe = await collectFinalAlias(stage, offline, deps);
        const receipt = {
            schemaVersion: 1,
            releaseId: config.releaseId,
            createdUtc: deps.now().toISOString(),
            configSha256: offline.configSha256,
            operationReceiptSha256: offline.operationReceiptSha256,
            auditReceiptSha256: offline.auditReceiptSha256,
            negativeReceiptSha256: offline.negativeReceiptSha256,
            acceptedManifestSha256: offline.acceptedManifestSha256,
            ownershipRead,
            finalAliasProbe,
            status: 'VERIFIED',
        };
        validateClosureReceipt(receipt, {
            releaseId: config.releaseId,
            configSha256: offline.configSha256,
            operationReceiptSha256: offline.operationReceiptSha256,
            auditReceiptSha256: offline.auditReceiptSha256,
            negativeReceiptSha256: offline.negativeReceiptSha256,
            acceptedManifestSha256: offline.acceptedManifestSha256,
            deploymentId: offline.authority.deployment.deploymentId,
            sourcePrefix: offline.authority.sourceGitHead.slice(0, 7),
            immutableUrl: offline.authority.deployment.immutableUrl,
            cwd: config.authorityProjectRoot,
            argv: ownershipArgv(config),
        });
        writeExclusive(path.join(stage, 'receipt.json'), Buffer.from(`${canonicalJson(receipt)}\n`));
        sealStage(stage);
        if (pathEntryExists(config.closureRoot)) fail('closureRoot.exists');
        fs.renameSync(stage, config.closureRoot);
        stage = undefined;
        stageOwned = false;
        fsyncDirectory(path.dirname(config.closureRoot));
        return receipt;
    } catch (error) {
        if (config) {
            try { publishDiagnostic(config, stageOwned ? stage : undefined, error, deps); }
            catch (diagnosticError) { error.message += `; closure.diagnostic=${diagnosticError.message}`; }
        }
        throw error;
    }
}

export async function runClosureFromArgv(argv, overrides = {}) {
    if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--config' || typeof argv[1] !== 'string') fail('closure.argv');
    return runClosureFromConfig(argv[1], overrides);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    runClosureFromArgv(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
