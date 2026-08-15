import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyCampaignV5 } from './verify-r14-campaign-v5.mjs';

const PRODUCT_FILES = Object.freeze({
    '/': ['index.html', 'text/html'],
    '/content.js': ['content.js', 'application/javascript'],
    '/game-core.js': ['game-core.js', 'application/javascript'],
    '/script.js': ['script.js', 'application/javascript'],
    '/style.css': ['style.css', 'text/css'],
});

const CONFIG_KEYS = Object.freeze([
    'schemaVersion', 'mode', 'projectName', 'accountId', 'environment', 'branch', 'releaseId', 'campaignRunId',
    'sourceGitHead', 'sourceGitTree', 'sourceSnapshotDir', 'sourceFreezePath', 'executionSourceDir', 'campaignDir',
    'campaignSpecPath', 'campaignReceiptPath', 'authorityProjectRoot', 'authorityWorkspaceRoot',
    'operationalRoot', 'stagingDir', 'baselineRoot', 'releaseRoot', 'deploymentRecordPath', 'deploymentReceiptPath',
    'rollbackBaselinePath', 'nodeExePath', 'nodeExeSha256', 'wranglerJsPath', 'wranglerJsSha256',
    'immutableUrl', 'aliasUrl',
]);

const RELEASE_ID = /^[0-9]{8}T[0-9]{6}Z-r14-public-smoke-v2$/;
const CAMPAIGN_ID = /^[0-9]{8}T[0-9]{6}Z-r10-korean-release$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMMUTABLE_URL = /^https:\/\/[0-9a-f]{8}\.penguin-exit-0\.pages\.dev\/$/;
const ALIAS_URL = /^https:\/\/penguin-exit-0\.pages\.dev\/$/;
const APPROVED_SOURCE_HEAD = '349573e9a4fc3006db71c823a0571dfe9ec26847';
const APPROVED_SOURCE_TREE = 'e87817dd9d5a9b84427f70b998336a76031b6e70';
const APPROVED_PRODUCT_SHA = Object.freeze({
    '/': '09a5f080870d193c339a166e16d787b7753547b04b64431176dc12c750a48ab2',
    '/content.js': 'af63396a4a4c7c96730a1f8bb306b2c2bdf3386abe14a94649cd65bb3ae4067f',
    '/game-core.js': 'b3fad87bd4eee3c608e4e2944a3572df272646534d95aded3a1463ebe6d708a2',
    '/script.js': '84d39e465968cc65252e5239ef94bddb57e2e8421366fd876c8887c6ad99837b',
    '/style.css': '7b16c4a5956cc6babb7eb199bead9e66291f4b25cfd38673dee3e19d862f3c05',
});
const APPROVED_SOURCE_FILES = Object.freeze({
    'scripts/public-smoke-v2-lib.mjs': '300f6d26ef3e0485ad96a3b5d8916ee65eaba4f7de220718509dd3653ee6ca83',
    'scripts/run-public-smoke-v2.mjs': '4179f37cacdd0013f1c9b181141e721c9a27f0969cf24e288e6ea9e716924009',
    'scripts/run-public-smoke-v2-operation.mjs': 'ce89d9aa5b71e237c46a9552fa27c2e1325502364b0cf2b1e8391cfc5c637d2a',
    'scripts/run-public-smoke-v2-negative-controls.mjs': '32e0258123388a67d79a20d730db5cf4dc569e8f1da61a842ef3c8333f9734b0',
    'scripts/close-public-smoke-v2.mjs': 'e5cb969cab19a4b9d967e217aceae7db7008824bfb5d476f1f972d6e624dd6a6',
    'scripts/finalize-public-smoke-v2.mjs': '1155d8383fef61a039dda9467a4800223e933332116c494e67eaee7c65e18513',
    'scripts/verify-public-smoke-v2.mjs': '29affc0e27e9b89cd906ca5354909f513e7b96543929c8b484cfe0b35689eecb',
    'scripts/verify-r10-campaign.mjs': 'fdb77fb80d6f6d8e5a55af9e1b7aa6809cb7ecc2ad6aa501499468cd28a2ad7a',
});
const OPERATOR_TIMEOUT_MS = 120000;
const IDENTITY_AUTHORITY_ENV = 'R14_TASK7_IDENTITY_AUTHORITY_ROOT';
const AUTHORITY_MANIFEST_NAME = 'authority-manifest.json';

function fail(invariant, detail = '') {
    throw new Error(`${invariant}${detail ? `: ${detail}` : ''}`);
}

function object(value, invariant) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(invariant, 'object');
    return value;
}

function exactKeys(value, expected, invariant) {
    const actual = Object.keys(object(value, invariant)).sort();
    const keys = [...expected].sort();
    if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail(invariant, `keys=${actual.join(',')}`);
}

function string(value, invariant) {
    if (typeof value !== 'string' || value.length === 0) fail(invariant);
    return value;
}

function absolute(value, invariant) {
    const raw = string(value, invariant);
    if (!path.isAbsolute(raw)) fail(invariant);
    const candidate = path.resolve(raw);
    return candidate;
}

function sha(value, invariant) {
    if (!SHA256.test(string(value, invariant))) fail(invariant);
    return value;
}

function noSymlinkAncestors(target, invariant) {
    let cursor = path.resolve(target);
    while (true) {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail(invariant, cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) return;
        cursor = parent;
    }
}

function contained(root, target, invariant) {
    const base = absolute(root, `${invariant}.root`);
    const candidate = absolute(target, invariant);
    if (candidate === base || !candidate.startsWith(`${base}${path.sep}`)) fail(invariant, 'escape');
    return candidate;
}

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(file) {
    return sha256Bytes(fs.readFileSync(file));
}

function jsonBytes(value) {
    return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function regularFiles(root, invariant) {
    const files = [];
    const visit = (directory, relative = '') => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            const entryRelative = path.join(relative, entry.name).split(path.sep).join('/');
            if (entry.isSymbolicLink()) fail(invariant, entryRelative);
            if (entry.isDirectory()) visit(entryPath, entryRelative);
            else if (entry.isFile()) files.push(entryRelative);
            else fail(invariant, entryRelative);
        }
    };
    visit(root);
    return files.sort((left, right) => left.localeCompare(right, 'en'));
}

function treeDigest(root, invariant) {
    const records = regularFiles(root, invariant).map((relative) => {
        const file = path.join(root, ...relative.split('/'));
        const bytes = fs.readFileSync(file);
        return `${relative}\0${bytes.length}\0${sha256Bytes(bytes)}\0`;
    }).join('');
    return sha256Bytes(Buffer.from(records, 'utf8'));
}

function identityAuthorityRoot() {
    const configured = process.env[IDENTITY_AUTHORITY_ENV];
    if (!configured) fail('operator.identity.authority');
    const root = absolute(configured, 'operator.identity.authority');
    noSymlinkAncestors(root, 'operator.identity.authority');
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail('operator.identity.authority');
    return root;
}

function validateAuthorityManifest(config, root = identityAuthorityRoot()) {
    const manifestPath = path.join(root, AUTHORITY_MANIFEST_NAME);
    noSymlinkAncestors(manifestPath, 'operator.identity.manifest');
    if (!fs.existsSync(manifestPath) || fs.lstatSync(manifestPath).isSymbolicLink() || !fs.statSync(manifestPath).isFile()) fail('operator.identity.manifest');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { fail('operator.identity.manifest'); }
    exactKeys(manifest, ['schemaVersion', 'projectName', 'accountId', 'sourceGitHead', 'sourceGitTree', 'nodeExeSha256', 'wranglerJsSha256', 'operatorSha256', 'campaignVerifierSha256', 'createdUtc'], 'operator.identity.manifest');
    if (manifest.schemaVersion !== 1 || manifest.projectName !== config.projectName || manifest.accountId !== config.accountId || manifest.sourceGitHead !== config.sourceGitHead || manifest.sourceGitTree !== config.sourceGitTree || manifest.nodeExeSha256 !== config.nodeExeSha256 || manifest.wranglerJsSha256 !== config.wranglerJsSha256 || manifest.operatorSha256 !== sha256File(fileURLToPath(import.meta.url)) || manifest.campaignVerifierSha256 !== APPROVED_SOURCE_FILES['scripts/verify-r10-campaign.mjs'] || Number.isNaN(Date.parse(string(manifest.createdUtc, 'operator.identity.manifest.createdUtc')))) fail('operator.identity.manifest');
    return { root, rootRealpath: fs.realpathSync(root), rootIdentity: rootIdentity(root, 'operator.identity.authority'), path: manifestPath, realpath: fs.realpathSync(manifestPath), bytes: fs.statSync(manifestPath).size, sha256: sha256File(manifestPath) };
}

function validateIssuance(config, authority, kind, id) {
    const file = path.join(authority.root, 'issuance', kind, `${id}.json`);
    noSymlinkAncestors(file, `operator.identity.${kind}.issuance`);
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) fail(`operator.identity.${kind}.issuance`);
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`operator.identity.${kind}.issuance`); }
    exactKeys(record, ['schemaVersion', 'kind', 'id', 'projectName', 'accountId', 'sourceGitHead', 'sourceGitTree', 'issuedUtc', 'authorityManifestSha256'], `operator.identity.${kind}.issuance`);
    if (record.schemaVersion !== 1 || record.kind !== kind || record.id !== id || record.projectName !== config.projectName || record.accountId !== config.accountId || record.sourceGitHead !== config.sourceGitHead || record.sourceGitTree !== config.sourceGitTree || record.authorityManifestSha256 !== authority.sha256 || Number.isNaN(Date.parse(string(record.issuedUtc, `operator.identity.${kind}.issuedUtc`)))) fail(`operator.identity.${kind}.issuance`);
    return { path: file, realpath: fs.realpathSync(file), bytes: fs.statSync(file).size, sha256: sha256File(file) };
}

function assertAuthorityManifestStable(authority) {
    const configuredRoot = identityAuthorityRoot();
    if (fs.realpathSync(configuredRoot) !== authority.rootRealpath) fail('operator.identity.authority.mutable');
    assertRootStable(authority.root, authority.rootRealpath, 'operator.identity.authority.mutable', authority.rootIdentity);
    if (!fs.existsSync(authority.path) || fs.lstatSync(authority.path).isSymbolicLink() || fs.realpathSync(authority.path) !== authority.realpath || sha256File(authority.path) !== authority.sha256 || fs.statSync(authority.path).size !== authority.bytes) fail('operator.identity.manifest.mutable');
}

function assertIssuanceStable(issuance, invariant) {
    if (!fs.existsSync(issuance.path) || fs.lstatSync(issuance.path).isSymbolicLink() || fs.realpathSync(issuance.path) !== issuance.realpath || fs.statSync(issuance.path).size !== issuance.bytes || sha256File(issuance.path) !== issuance.sha256) fail(invariant);
}

function rootIdentity(root, invariant) {
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) fail(invariant);
    return `${stat.dev}:${stat.ino}`;
}

function assertRootStable(root, expectedRealpath, invariant, expectedIdentity = null) {
    noSymlinkAncestors(root, invariant);
    if (fs.realpathSync(root) !== expectedRealpath || (expectedIdentity && rootIdentity(root, invariant) !== expectedIdentity)) fail(invariant);
}

function validateConfigSource(configSource, config, authority) {
    if (!configSource) return null;
    const file = absolute(configSource.path, 'operator.config.source.path');
    noSymlinkAncestors(file, 'operator.config.source.path');
    contained(authority.root, file, 'operator.config.source.path');
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) fail('operator.config.source');
    const bytes = fs.readFileSync(file);
    const sha256 = sha256Bytes(bytes);
    if (sha256 !== configSource.sha256 || bytes.length !== configSource.bytes || sha256Bytes(jsonBytes(config)) !== configSource.objectSha256) fail('operator.config.source');
    return { path: file, realpath: fs.realpathSync(file), bytes: bytes.length, sha256, objectSha256: configSource.objectSha256 };
}

function assertConfigSourceStable(configBinding, config) {
    if (!configBinding) return;
    if (fs.lstatSync(configBinding.path).isSymbolicLink() || fs.realpathSync(configBinding.path) !== configBinding.realpath) fail('operator.config.source.mutable');
    const bytes = fs.readFileSync(configBinding.path);
    if (bytes.length !== configBinding.bytes || sha256Bytes(bytes) !== configBinding.sha256 || sha256Bytes(jsonBytes(config)) !== configBinding.objectSha256) fail('operator.config.source.mutable');
}

function executionScriptHashes() {
    const files = {
        'scripts/operator-deploy-public-smoke-v2.mjs': fileURLToPath(import.meta.url),
        'scripts/verify-r14-campaign-v5.mjs': path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify-r14-campaign-v5.mjs'),
        'scripts/public-smoke-v2-lib.mjs': path.join(path.dirname(fileURLToPath(import.meta.url)), 'public-smoke-v2-lib.mjs'),
        'scripts/run-public-smoke-v2.mjs': path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-public-smoke-v2.mjs'),
        'scripts/run-public-smoke-v2-operation.mjs': path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-public-smoke-v2-operation.mjs'),
        'scripts/run-public-smoke-v2-negative-controls.mjs': path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-public-smoke-v2-negative-controls.mjs'),
        'scripts/close-public-smoke-v2.mjs': path.join(path.dirname(fileURLToPath(import.meta.url)), 'close-public-smoke-v2.mjs'),
        'scripts/finalize-public-smoke-v2.mjs': path.join(path.dirname(fileURLToPath(import.meta.url)), 'finalize-public-smoke-v2.mjs'),
        'scripts/verify-public-smoke-v2.mjs': path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify-public-smoke-v2.mjs'),
        'scripts/verify-r10-campaign.mjs': path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify-r14-campaign-v5.mjs'),
    };
    const result = Object.fromEntries(Object.entries(files).map(([relative, file]) => {
        if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) fail('operator.executionSource', relative);
        return [relative, { path: file, realpath: fs.realpathSync(file), sha256: sha256File(file) }];
    }));
    for (const [relative, expected] of Object.entries(APPROVED_SOURCE_FILES)) if (result[relative]?.sha256 !== expected) fail('operator.executionSource.approved', relative);
    return result;
}

function validateToolFile(file, expectedSha, invariant) {
    const absolutePath = absolute(file, invariant);
    if (!fs.existsSync(absolutePath) || fs.lstatSync(absolutePath).isSymbolicLink() || !fs.statSync(absolutePath).isFile()) fail(invariant);
    if (sha256File(absolutePath) !== expectedSha) fail(`${invariant}.sha256`);
    return absolutePath;
}

function utcNow() {
    return new Date().toISOString();
}

function normalizeResult(result) {
    if (!result || typeof result !== 'object') fail('operator.external.result');
    const exitCode = result.exitCode ?? result.status ?? 2;
    const signal = result.signal ?? null;
    const timedOut = result.timedOut === true;
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? '');
    return { exitCode, signal, timedOut, stdout, stderr };
}

function outputPaths(config) {
    return [
        config.deploymentRecordPath,
        config.deploymentReceiptPath,
        config.stagingDir,
        path.join(config.operationalRoot, 'campaign-verifier.json.stdout.bin'),
        path.join(config.operationalRoot, 'campaign-verifier.json.stderr.bin'),
        path.join(config.operationalRoot, 'pre.json.stdout.bin'),
        path.join(config.operationalRoot, 'pre.json.stderr.bin'),
        path.join(config.operationalRoot, 'deploy.json.stdout.bin'),
        path.join(config.operationalRoot, 'deploy.json.stderr.bin'),
        path.join(config.operationalRoot, 'post.json.stdout.bin'),
        path.join(config.operationalRoot, 'post.json.stderr.bin'),
    ];
}

function pathExists(candidate) {
    try { fs.lstatSync(candidate); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function parseOperatorArgv(argv) {
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true };
    if (argv.length !== 4 || argv[0] !== '--config' || !path.isAbsolute(argv[1]) || argv[2] !== '--mode' || !['deploy', 'rollback'].includes(argv[3])) fail('operator.argv');
    return { configPath: path.resolve(argv[1]), mode: argv[3] };
}

export function validateOperatorConfig(config) {
    exactKeys(config, CONFIG_KEYS, 'operator.config');
    if (config.schemaVersion !== 1 || !['deploy', 'rollback'].includes(config.mode)) fail('operator.config.schema');
    if (config.projectName !== 'penguin-exit-0' || !ACCOUNT_ID.test(string(config.accountId, 'operator.config.accountId')) || config.environment !== 'Production' || config.branch !== 'main') fail('operator.config.project');
    if (!RELEASE_ID.test(string(config.releaseId, 'operator.config.releaseId')) || !CAMPAIGN_ID.test(string(config.campaignRunId, 'operator.config.campaignRunId'))) fail('operator.config.identity');
    if (config.sourceGitHead !== APPROVED_SOURCE_HEAD || config.sourceGitTree !== APPROVED_SOURCE_TREE) fail('operator.config.source');
    sha(config.nodeExeSha256, 'operator.config.nodeExeSha256'); sha(config.wranglerJsSha256, 'operator.config.wranglerJsSha256');
    if (!IMMUTABLE_URL.test(string(config.immutableUrl, 'operator.config.immutableUrl')) || !ALIAS_URL.test(string(config.aliasUrl, 'operator.config.aliasUrl'))) fail('operator.config.urls');
    for (const key of ['sourceSnapshotDir', 'sourceFreezePath', 'executionSourceDir', 'campaignDir', 'campaignSpecPath', 'campaignReceiptPath', 'authorityProjectRoot', 'authorityWorkspaceRoot', 'operationalRoot', 'stagingDir', 'baselineRoot', 'releaseRoot', 'deploymentRecordPath', 'deploymentReceiptPath', 'rollbackBaselinePath', 'nodeExePath', 'wranglerJsPath']) absolute(config[key], `operator.config.${key}`);
    for (const key of ['sourceSnapshotDir', 'sourceFreezePath', 'executionSourceDir', 'campaignDir', 'campaignSpecPath', 'campaignReceiptPath', 'authorityProjectRoot', 'authorityWorkspaceRoot', 'operationalRoot', 'stagingDir', 'baselineRoot', 'releaseRoot', 'deploymentRecordPath', 'deploymentReceiptPath', 'rollbackBaselinePath', 'wranglerJsPath']) noSymlinkAncestors(config[key], `operator.config.${key}`);
    if (path.resolve(config.nodeExePath) !== path.resolve(process.execPath)) fail('operator.config.nodeAuthority');
    validateToolFile(config.nodeExePath, config.nodeExeSha256, 'operator.config.nodeExe');
    validateToolFile(config.wranglerJsPath, config.wranglerJsSha256, 'operator.config.wranglerJs');
    const wranglerInAuthority = [config.authorityProjectRoot, config.authorityWorkspaceRoot].some((root) => { const candidate = path.resolve(config.wranglerJsPath); const base = path.resolve(root); return candidate.startsWith(`${base}${path.sep}`); });
    if (!wranglerInAuthority) fail('operator.config.wranglerAuthority');
    contained(config.sourceSnapshotDir, config.sourceFreezePath, 'operator.config.sourceFreeze');
    if (path.resolve(config.stagingDir) === path.resolve(config.operationalRoot) || !path.resolve(config.stagingDir).startsWith(`${path.resolve(config.operationalRoot)}${path.sep}`)) fail('operator.config.staging');
    if (path.resolve(config.baselineRoot) === path.resolve(config.operationalRoot) || !path.resolve(config.baselineRoot).startsWith(`${path.resolve(config.operationalRoot)}${path.sep}`)) fail('operator.config.baseline');
    if (!path.resolve(config.deploymentRecordPath).startsWith(`${path.resolve(config.releaseRoot)}${path.sep}`)) fail('operator.config.record');
    if (!path.resolve(config.deploymentReceiptPath).startsWith(`${path.resolve(config.operationalRoot)}${path.sep}`)) fail('operator.config.receipt');
    if (!path.resolve(config.rollbackBaselinePath).startsWith(`${path.resolve(config.operationalRoot)}${path.sep}`)) fail('operator.config.rollbackBaseline');
    for (const [left, right] of [[config.sourceSnapshotDir, config.operationalRoot], [config.sourceSnapshotDir, config.releaseRoot], [config.operationalRoot, config.releaseRoot]]) {
        const a = path.resolve(left); const b = path.resolve(right);
        if (a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)) fail('operator.config.roots');
    }
    const authorityRoot = identityAuthorityRoot();
    if ([config.sourceSnapshotDir, config.operationalRoot, config.releaseRoot].some((candidate) => path.resolve(candidate) === authorityRoot || path.resolve(candidate).startsWith(`${authorityRoot}${path.sep}`) || authorityRoot.startsWith(`${path.resolve(candidate)}${path.sep}`))) fail('operator.config.identityAuthority');
    validateAuthorityManifest(config, authorityRoot);
    return config;
}

function validateSourceSnapshot(config) {
    const sourceRoot = absolute(config.sourceSnapshotDir, 'operator.source.root');
    if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) fail('operator.source.snapshot');
    const freezePath = absolute(config.sourceFreezePath, 'operator.source.freeze');
    if (!fs.existsSync(freezePath) || fs.lstatSync(freezePath).isSymbolicLink()) fail('operator.source.freeze');
    let freeze;
    try { freeze = JSON.parse(fs.readFileSync(freezePath, 'utf8')); } catch { fail('operator.source.freeze'); }
    exactKeys(freeze, ['schemaVersion', 'sourceGitHead', 'sourceGitTree', 'operatorSha256', 'campaignVerifierSha256', 'nodeExeSha256', 'wranglerJsSha256', 'sourceFiles'], 'operator.source.freeze');
    const verifierSnapshot = path.join(sourceRoot, 'scripts', 'verify-r10-campaign.mjs');
    const operatorPath = fileURLToPath(import.meta.url);
    const verifierHash = fs.existsSync(verifierSnapshot) && !fs.lstatSync(verifierSnapshot).isSymbolicLink() ? sha256File(verifierSnapshot) : null;
    if (freeze.schemaVersion !== 1 || freeze.sourceGitHead !== config.sourceGitHead || freeze.sourceGitTree !== config.sourceGitTree || freeze.operatorSha256 !== sha256File(operatorPath) || freeze.campaignVerifierSha256 !== APPROVED_SOURCE_FILES['scripts/verify-r10-campaign.mjs'] || verifierHash !== freeze.campaignVerifierSha256 || freeze.nodeExeSha256 !== config.nodeExeSha256 || freeze.wranglerJsSha256 !== config.wranglerJsSha256) fail('operator.source');
    exactKeys(freeze.sourceFiles, Object.keys(APPROVED_SOURCE_FILES), 'operator.source.manifest');
    for (const [relative, expectedSha] of Object.entries(APPROVED_SOURCE_FILES)) {
        if (freeze.sourceFiles[relative] !== expectedSha) fail('operator.source.manifest', relative);
        const file = path.join(sourceRoot, ...relative.split('/'));
        if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || sha256File(file) !== expectedSha) fail('operator.source.manifest', relative);
    }
    const productFiles = {};
    for (const [publicPath, [name, mime]] of Object.entries(PRODUCT_FILES)) {
        const file = path.join(sourceRoot, name);
        if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) fail('operator.product', publicPath);
        const bytes = fs.statSync(file).size;
        if (bytes <= 0) fail('operator.product', `${publicPath}.bytes`);
        const digest = sha256File(file);
        if (digest !== APPROVED_PRODUCT_SHA[publicPath]) fail('operator.product', `${publicPath}.sha256`);
        productFiles[publicPath] = { bytes, mime, sha256: digest };
    }
    const allowed = new Set([...Object.keys(APPROVED_SOURCE_FILES), ...Object.values(PRODUCT_FILES).map(([name]) => name), path.relative(sourceRoot, freezePath).split(path.sep).join('/')]);
    for (const relative of regularFiles(sourceRoot, 'operator.source.manifest')) if (!allowed.has(relative)) fail('operator.source.manifest', relative);
    return productFiles;
}

function validateCampaignInputs(config) {
    const campaign = absolute(config.campaignDir, 'operator.inputs.campaign');
    const specPath = absolute(config.campaignSpecPath, 'operator.inputs.campaignSpec');
    contained(campaign, specPath, 'operator.inputs.campaignSpec');
    const required = [campaign, specPath, config.campaignReceiptPath, path.join(campaign, 'claims.json'), path.join(campaign, 'submission-envelope.json'), path.join(campaign, 'candidate-inventory.json')];
    if (required.some((file) => !fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink())) fail('operator.inputs.campaign');
    noSymlinkAncestors(campaign, 'operator.inputs.campaign');
    if (path.resolve(config.campaignReceiptPath) !== path.join(campaign, 'campaign-receipt.json') || !fs.statSync(specPath).isFile()) fail('operator.inputs.campaignReceipt');
    const verifierSnapshot = path.join(config.sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs');
    const verifierTemplate = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify-r14-campaign-v5.mjs');
    if (!fs.existsSync(verifierSnapshot) || fs.lstatSync(verifierSnapshot).isSymbolicLink() || !fs.existsSync(verifierTemplate) || sha256File(verifierSnapshot) !== sha256File(verifierTemplate)) fail('operator.inputs.campaignVerifier');
    return { campaign, campaignSpecPath: specPath, campaignSpecBytes: fs.statSync(specPath).size, campaignSpecSha256: sha256File(specPath), campaignReceiptSha256: sha256File(path.join(campaign, 'campaign-receipt.json')) };
}

function assertOutputsAbsent(config) {
    for (const output of outputPaths(config)) if (pathExists(output)) fail('RELEASE_ID_CONSUMED');
}

async function acquireLock(lockPath, binding, invariant = 'RELEASE_ID_CONSUMED') {
    try { await fsp.mkdir(lockPath); }
    catch (error) { if (error.code === 'EEXIST') fail(invariant); throw error; }
    try { await writeJsonExclusive(path.join(lockPath, 'binding.json'), binding); }
    catch (error) { throw new Error(`INDETERMINATE: ${invariant}.publication: ${error.message}`); }
    return lockPath;
}

function describeIdentityLock(lockPath, authorityRoot, invariant) {
    contained(authorityRoot, lockPath, invariant);
    noSymlinkAncestors(lockPath, invariant);
    if (!fs.existsSync(lockPath) || !fs.statSync(lockPath).isDirectory()) fail(invariant);
    const bindingPath = path.join(lockPath, 'binding.json');
    noSymlinkAncestors(bindingPath, invariant);
    if (!fs.existsSync(bindingPath) || fs.lstatSync(bindingPath).isSymbolicLink() || !fs.statSync(bindingPath).isFile()) fail(invariant);
    return { path: lockPath, realpath: fs.realpathSync(lockPath), identity: rootIdentity(lockPath, invariant), bindingPath, bindingRealpath: fs.realpathSync(bindingPath), bindingBytes: fs.statSync(bindingPath).size, bindingSha256: sha256File(bindingPath) };
}

function assertIdentityLockStable(lock, authorityRoot, invariant) {
    contained(authorityRoot, lock.path, invariant);
    assertRootStable(lock.path, lock.realpath, invariant, lock.identity);
    if (!fs.existsSync(lock.bindingPath) || fs.lstatSync(lock.bindingPath).isSymbolicLink() || fs.realpathSync(lock.bindingPath) !== lock.bindingRealpath || fs.statSync(lock.bindingPath).size !== lock.bindingBytes || sha256File(lock.bindingPath) !== lock.bindingSha256) fail(invariant);
}

function assertIdentityLocksStable(identity, invariant = 'operator.identity.lock.mutable') {
    assertIdentityLockStable(identity.releaseLock, identity.root, `${invariant}.release`);
    assertIdentityLockStable(identity.campaignLock, identity.root, `${invariant}.campaign`);
}

function identityLockReceiptFields(identity) {
    return {
        releaseLockPath: identity.releaseLock.path,
        releaseLockRealpath: identity.releaseLock.realpath,
        releaseLockIdentity: identity.releaseLock.identity,
        releaseLockBindingPath: identity.releaseLock.bindingPath,
        releaseLockBindingRealpath: identity.releaseLock.bindingRealpath,
        releaseLockBindingBytes: identity.releaseLock.bindingBytes,
        releaseLockBindingSha256: identity.releaseLock.bindingSha256,
        campaignLockPath: identity.campaignLock.path,
        campaignLockRealpath: identity.campaignLock.realpath,
        campaignLockIdentity: identity.campaignLock.identity,
        campaignLockBindingPath: identity.campaignLock.bindingPath,
        campaignLockBindingRealpath: identity.campaignLock.bindingRealpath,
        campaignLockBindingBytes: identity.campaignLock.bindingBytes,
        campaignLockBindingSha256: identity.campaignLock.bindingSha256,
    };
}

async function acquireLaunchLock(config) {
    return acquireLock(path.join(config.operationalRoot, 'launch.lock'), {
        schemaVersion: 1,
        releaseId: config.releaseId,
        campaignRunId: config.campaignRunId,
        sourceGitHead: config.sourceGitHead,
        sourceGitTree: config.sourceGitTree,
        createdUtc: utcNow(),
    });
}

async function acquireCampaignLock(config, campaign, campaignTreeDigest, campaignReceiptSha256) {
    const lockPath = path.join(config.operationalRoot, 'campaign.lock');
    noSymlinkAncestors(lockPath, 'operator.inputs.campaignLock');
    return acquireLock(lockPath, {
        schemaVersion: 1,
        campaignRunId: config.campaignRunId,
        campaignPath: path.resolve(campaign),
        campaignTreeDigest,
        campaignReceiptSha256,
        createdUtc: utcNow(),
    });
}

async function acquireIdentityLocks(config, authority, configBinding) {
    const releaseIssuance = validateIssuance(config, authority, 'release', config.releaseId);
    const campaignIssuance = validateIssuance(config, authority, 'campaign', config.campaignRunId);
    const namespace = path.join(authority.root, 'r14-task7-identities');
    contained(authority.root, namespace, 'operator.identity.namespace');
    noSymlinkAncestors(namespace, 'operator.identity.namespace');
    await fsp.mkdir(path.join(namespace, 'release'), { recursive: true });
    await fsp.mkdir(path.join(namespace, 'campaign'), { recursive: true });
    noSymlinkAncestors(path.join(namespace, 'release'), 'operator.identity.namespace');
    noSymlinkAncestors(path.join(namespace, 'campaign'), 'operator.identity.namespace');
    assertAuthorityManifestStable(authority);
    const binding = { schemaVersion: 1, releaseId: config.releaseId, campaignRunId: config.campaignRunId, sourceGitHead: config.sourceGitHead, sourceGitTree: config.sourceGitTree, authorityRootRealpath: authority.rootRealpath, authorityManifestPath: authority.path, authorityManifestRealpath: authority.realpath, authorityManifestBytes: authority.bytes, authorityManifestSha256: authority.sha256, releaseIssuancePath: releaseIssuance.path, releaseIssuanceRealpath: releaseIssuance.realpath, releaseIssuanceBytes: releaseIssuance.bytes, releaseIssuanceSha256: releaseIssuance.sha256, campaignIssuancePath: campaignIssuance.path, campaignIssuanceRealpath: campaignIssuance.realpath, campaignIssuanceBytes: campaignIssuance.bytes, campaignIssuanceSha256: campaignIssuance.sha256, configBinding: configBinding ?? null, createdUtc: utcNow() };
    const releaseLockPath = path.join(namespace, 'release', `${config.releaseId}.lock`);
    await acquireLock(releaseLockPath, { ...binding, kind: 'release' });
    const releaseLock = describeIdentityLock(releaseLockPath, authority.root, 'operator.identity.lock.release');
    assertAuthorityManifestStable(authority);
    noSymlinkAncestors(path.join(namespace, 'campaign'), 'operator.identity.namespace');
    const campaignLockPath = path.join(namespace, 'campaign', `${config.campaignRunId}.lock`);
    await acquireLock(campaignLockPath, { ...binding, kind: 'campaign' });
    const campaignLock = describeIdentityLock(campaignLockPath, authority.root, 'operator.identity.lock.campaign');
    const identity = { ...authority, releaseIssuance, campaignIssuance, releaseLock, campaignLock };
    assertIdentityLocksStable(identity);
    return identity;
}

export function buildDeployArgv(config, stagingDir = config.stagingDir) {
    validateOperatorConfig(config);
    return [config.nodeExePath, config.wranglerJsPath, 'pages', 'deploy', path.resolve(stagingDir), '--project-name', config.projectName, '--branch', config.branch, '--commit-hash', config.sourceGitHead, '--commit-dirty=false', '--no-bundle'];
}

export function buildRollbackArgv(config, baselineDir = config.baselineRoot, sourceGitHead = config.sourceGitHead) {
    validateOperatorConfig(config);
    if (!SHA1.test(string(sourceGitHead, 'operator.rollback.sourceGitHead'))) fail('operator.rollback.sourceGitHead');
    return [config.nodeExePath, config.wranglerJsPath, 'pages', 'deploy', path.resolve(baselineDir), '--project-name', config.projectName, '--branch', config.branch, '--commit-hash', sourceGitHead, '--commit-dirty=false', '--no-bundle'];
}

export function buildCampaignVerifierArgv(config) {
    validateOperatorConfig(config);
    return [
        config.nodeExePath,
        path.join(config.sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs'),
        '--campaign', config.campaignDir,
        '--spec', config.campaignSpecPath,
        '--source', config.sourceSnapshotDir,
        '--execution-source', config.executionSourceDir,
        '--run', config.campaignRunId,
        '--authority-project', config.authorityProjectRoot,
        '--authority-workspace', config.authorityWorkspaceRoot,
    ];
}

function buildOwnershipArgv(config) {
    validateOperatorConfig(config);
    assertAuthorityManifestStable(validateAuthorityManifest(config));
    return [config.nodeExePath, config.wranglerJsPath, 'pages', 'deployment', 'list', '--project-name', config.projectName, '--environment', 'production', '--json'];
}

function parseRows(result, phase) {
    const normalized = normalizeResult(result);
    if (normalized.timedOut || normalized.exitCode !== 0 || normalized.signal !== null || normalized.stderr.length !== 0) fail(`operator.${phase}`);
    let rows;
    try { rows = JSON.parse(normalized.stdout.toString('utf8')); } catch { fail(`operator.${phase}.json`); }
    if (!Array.isArray(rows) || rows.length < 1) fail(`operator.${phase}.rows`);
    return { rows, normalized };
}

export function validateOwnershipRow(row, config, invariant, sourceGitHead = config.sourceGitHead, bindSource = true, allowNormalizedHarness = false) {
    exactKeys(row, ['Id', 'Environment', 'Branch', 'Source', 'Deployment', 'Status', 'Build'], invariant);
    const source = string(row.Source, `${invariant}.source`);
    const id = string(row.Id, `${invariant}.id`);
    const currentWranglerSuccess = typeof row.Status === 'string' && /^(?:less than a minute|(?:(?:about|over|almost) )?[1-9]\d* (?:second|minute|hour|day|week|month|year)s?) ago$/.test(row.Status) && row.Build === `https://dash.cloudflare.com/${config.accountId}/pages/view/${config.projectName}/${id}`;
    const normalizedHarnessSuccess = allowNormalizedHarness && row.Status === 'success' && row.Build === 'success';
    if (!/^[0-9a-f]{7,40}$/.test(source) || !DEPLOYMENT_ID.test(id) || row.Environment !== 'Production' || row.Branch !== 'main' || (bindSource && source !== sourceGitHead.slice(0, 7)) || (!currentWranglerSuccess && !normalizedHarnessSuccess) || !IMMUTABLE_URL.test(string(row.Deployment, `${invariant}.deployment`)) || row.Deployment !== `https://${id.slice(0, 8)}.penguin-exit-0.pages.dev/`) fail(invariant);
    return row;
}

async function defaultSpawnProcess(argv, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout = [], stderr = [];
        let timedOut = false;
        let settled = false;
        const timeout = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs ?? OPERATOR_TIMEOUT_MS);
        const finish = (value) => { if (settled) return; settled = true; clearTimeout(timeout); resolve(value); };
        child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
        child.once('error', (error) => { if (settled) return; settled = true; clearTimeout(timeout); reject(error); });
        child.once('close', (exitCode, signal) => finish({ exitCode, signal, timedOut, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    });
}

async function writeJsonExclusive(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const descriptor = fs.openSync(file, 'wx');
    try {
        const bytes = jsonBytes(value);
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    return file;
}

function writeJsonExclusiveSync(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const descriptor = fs.openSync(file, 'wx');
    try {
        fs.writeFileSync(descriptor, jsonBytes(value));
        fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    return file;
}

export async function stageProductFiles(config, productFiles = validateSourceSnapshot(config)) {
    if (fs.existsSync(config.stagingDir)) fail('operator.preflight.staging');
    await fsp.mkdir(config.stagingDir, { recursive: true });
    for (const [, [name]] of Object.entries(PRODUCT_FILES)) {
        const source = path.join(config.sourceSnapshotDir, name);
        const destination = path.join(config.stagingDir, name);
        await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
        if (sha256File(destination) !== productFiles[Object.entries(PRODUCT_FILES).find(([, [candidate]]) => candidate === name)[0]].sha256) fail('operator.staging.sha');
    }
    return config.stagingDir;
}

function validateStagingTree(stagingDir, productFiles, invariant = 'operator.staging') {
    const expected = Object.values(PRODUCT_FILES).map(([name]) => name).sort();
    const actual = regularFiles(stagingDir, `${invariant}.tree`);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${invariant}.tree`);
    for (const [publicPath, [name]] of Object.entries(PRODUCT_FILES)) {
        const file = path.join(stagingDir, name);
        if (fs.statSync(file).size !== productFiles[publicPath].bytes || sha256File(file) !== productFiles[publicPath].sha256) fail(`${invariant}.bytes`, publicPath);
    }
    return treeDigest(stagingDir, `${invariant}.tree`);
}

function assertPreExternalStable(config, state) {
    try {
        validateOperatorConfig(config);
        assertRootStable(config.sourceSnapshotDir, state.sourceSnapshotRealpath, 'operator.preExternal.source.root.mutable', state.sourceSnapshotIdentity);
        if (treeDigest(config.sourceSnapshotDir, 'operator.preExternal.source.tree') !== state.sourceSnapshotTreeDigest) fail('operator.preExternal.source.mutable');
        if (JSON.stringify(executionScriptHashes()) !== JSON.stringify(state.executionScripts)) fail('operator.preExternal.executionSource.mutable');
        if (state.campaignDir) {
            assertRootStable(state.campaignDir, state.campaignRealpath, 'operator.preExternal.campaign.root.mutable', state.campaignIdentity);
            if (treeDigest(state.campaignDir, 'operator.preExternal.campaign.tree') !== state.campaignTreeDigest) fail('operator.preExternal.campaign.mutable');
        }
        assertAuthorityManifestStable(state.authority);
        assertIssuanceStable(state.identity.releaseIssuance, 'operator.preExternal.release.issuance.mutable');
        assertIssuanceStable(state.identity.campaignIssuance, 'operator.preExternal.campaign.issuance.mutable');
        assertIdentityLocksStable(state.identity, 'operator.preExternal.identity.lock.mutable');
        assertConfigSourceStable(state.configBinding, config);
        const stagingDir = state.stagingDir ?? config.stagingDir;
        assertRootStable(stagingDir, state.stagingRealpath, 'operator.preExternal.staging.root.mutable', state.stagingIdentity);
        if (validateStagingTree(stagingDir, state.productFiles, 'operator.preExternal.staging') !== state.stagingTreeDigest) fail('operator.preExternal.staging.mutable');
    } catch (error) {
        if (String(error.message).startsWith('operator.preExternal.')) throw error;
        throw new Error(`operator.preExternal: ${error.message}`);
    }
}

function deploymentRecord(config, row, productFiles, allowNormalizedHarness = false) {
    validateOwnershipRow(row, config, 'operator.deploymentRecord', config.sourceGitHead, true, allowNormalizedHarness);
    return {
        schemaVersion: 1,
        projectName: config.projectName,
        deploymentId: row.Id,
        environment: row.Environment,
        branch: row.Branch,
        sourceGitHead: config.sourceGitHead,
        immutableUrl: row.Deployment,
        aliasUrl: config.aliasUrl,
        productFiles,
        capturedUtc: utcNow(),
    };
}

function validateRollbackBaseline(config, baseline) {
    exactKeys(baseline, ['schemaVersion', 'projectName', 'environment', 'branch', 'deploymentId', 'immutableUrl', 'aliasUrl', 'sourceGitHead', 'sourceGitTree', 'productFiles', 'capturedUtc'], 'rollback.baseline');
    if (baseline.schemaVersion !== 1 || baseline.projectName !== config.projectName || baseline.environment !== 'Production' || baseline.branch !== 'main' || !DEPLOYMENT_ID.test(baseline.deploymentId) || !IMMUTABLE_URL.test(string(baseline.immutableUrl, 'rollback.baseline.immutableUrl')) || baseline.immutableUrl !== `https://${baseline.deploymentId.slice(0, 8)}.penguin-exit-0.pages.dev/` || baseline.aliasUrl !== config.aliasUrl || !SHA1.test(baseline.sourceGitHead) || !SHA1.test(baseline.sourceGitTree) || Number.isNaN(Date.parse(string(baseline.capturedUtc, 'rollback.baseline.capturedUtc')))) fail('rollback.baseline');
    const productFiles = object(baseline.productFiles, 'rollback.baseline.productFiles');
    exactKeys(productFiles, Object.keys(PRODUCT_FILES), 'rollback.baseline.productFiles');
    for (const [publicPath, [name, mime]] of Object.entries(PRODUCT_FILES)) {
        const record = object(productFiles[publicPath], `rollback.baseline.productFiles.${publicPath}`);
        exactKeys(record, ['bytes', 'mime', 'sha256'], `rollback.baseline.productFiles.${publicPath}`);
        if (!Number.isInteger(record.bytes) || record.bytes <= 0 || record.mime !== mime || !SHA256.test(record.sha256)) fail('rollback.baseline.productFiles', publicPath);
        if (record.sha256 !== APPROVED_PRODUCT_SHA[publicPath]) fail('rollback.baseline.productFiles.sha256', publicPath);
    }
    return productFiles;
}

function capture(pathName, argv, cwd, result, startedUtc, finishedUtc) {
    const normalized = normalizeResult(result);
    return { argv, cwd, startedUtc, finishedUtc, exitCode: normalized.exitCode, signal: normalized.signal, stdoutPath: `${pathName}.stdout.bin`, stdoutBytes: normalized.stdout.length, stdoutSha256: sha256Bytes(normalized.stdout), stderrPath: `${pathName}.stderr.bin`, stderrBytes: normalized.stderr.length, stderrSha256: sha256Bytes(normalized.stderr) };
}

async function persistCapture(capturePath, result) {
    const normalized = normalizeResult(result);
    await writeBinaryExclusive(`${capturePath}.stdout.bin`, normalized.stdout);
    await writeBinaryExclusive(`${capturePath}.stderr.bin`, normalized.stderr);
}

function assertCaptureStable(captureRecord, operationalRoot, invariant) {
    if (captureRecord === null) return;
    for (const stream of ['stdout', 'stderr']) {
        const file = captureRecord[`${stream}Path`];
        contained(operationalRoot, file, invariant);
        noSymlinkAncestors(file, invariant);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== captureRecord[`${stream}Bytes`] || sha256File(file) !== captureRecord[`${stream}Sha256`]) fail(invariant);
    }
}

async function writeBinaryExclusive(file, bytes) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const descriptor = fs.openSync(file, 'wx');
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    return file;
}

async function runCampaignVerifier(config, deps, run) {
    const argv = buildCampaignVerifierArgv(config);
    if (deps.runCampaignVerifier) {
        try { await deps.runCampaignVerifier(config, argv); }
        catch (error) { throw new Error(`operator.campaignVerifier: ${error.message}`); }
        return null;
    }
    const captured = await run(argv, 'campaign-verifier');
    const normalized = normalizeResult(captured.result);
    if (normalized.timedOut || normalized.exitCode !== 0 || normalized.signal !== null || normalized.stderr.length !== 0 || normalized.stdout.toString('utf8') !== 'R10_CAMPAIGN_GATE=VERIFIED\n') fail('operator.campaignVerifier');
    return captured.capture;
}

async function runDeploy(config, deps) {
    const allowNormalizedHarness = deps.allowNormalizedOwnershipRows === true;
    const authority = validateAuthorityManifest(config);
    const configBinding = validateConfigSource(deps.configSource, config, authority);
    const identity = await acquireIdentityLocks(config, authority, configBinding);
    assertOutputsAbsent(config);
    await acquireLaunchLock(config);
    const productFiles = validateSourceSnapshot(config);
    const sourceSnapshotRealpathBefore = fs.realpathSync(config.sourceSnapshotDir);
    const sourceSnapshotIdentityBefore = rootIdentity(config.sourceSnapshotDir, 'operator.source.root');
    const sourceSnapshotTreeDigestBefore = treeDigest(config.sourceSnapshotDir, 'operator.source.tree');
    const executionScriptsBefore = executionScriptHashes();
    const campaignInput = validateCampaignInputs(config);
    const campaignRealpathBefore = fs.realpathSync(campaignInput.campaign);
    const campaignIdentityBefore = rootIdentity(campaignInput.campaign, 'operator.campaign.root');
    const campaignTreeDigestBefore = treeDigest(campaignInput.campaign, 'operator.campaign.tree');
    await acquireCampaignLock(config, campaignInput.campaign, campaignTreeDigestBefore, campaignInput.campaignReceiptSha256);
    if (!deps.runCampaignVerifier) {
        try {
            const verified = verifyCampaignV5({
                campaignDir: campaignInput.campaign,
                specPath: config.campaignSpecPath,
                sourceRoot: config.sourceSnapshotDir,
                expectedRunId: config.campaignRunId,
                authorityProjectRoot: config.authorityProjectRoot,
                executionRoot: config.executionSourceDir,
            });
            if (verified.status !== 'VERIFIED' || verified.sourceGitHead !== config.sourceGitHead) fail('operator.inputs.campaign');
        }
        catch (error) { fail('operator.inputs.campaign', error.message); }
    }
    const sourceSnapshotTreeDigestAfterVerifier = treeDigest(config.sourceSnapshotDir, 'operator.source.tree');
    assertRootStable(config.sourceSnapshotDir, sourceSnapshotRealpathBefore, 'operator.source.root.mutable', sourceSnapshotIdentityBefore);
    assertRootStable(campaignInput.campaign, campaignRealpathBefore, 'operator.campaign.root.mutable', campaignIdentityBefore);
    if (sourceSnapshotTreeDigestAfterVerifier !== sourceSnapshotTreeDigestBefore) fail('operator.source.mutable');
    const executionScriptsAfterVerifier = executionScriptHashes();
    if (JSON.stringify(executionScriptsAfterVerifier) !== JSON.stringify(executionScriptsBefore)) fail('operator.executionSource.mutable');
    const campaignTreeDigestAfterVerifier = treeDigest(campaignInput.campaign, 'operator.campaign.tree');
    if (campaignTreeDigestAfterVerifier !== campaignTreeDigestBefore) fail('operator.campaign.mutable');
    const spawnProcess = deps.spawnProcess ?? defaultSpawnProcess;
    const cwd = path.resolve(config.operationalRoot);
    const run = async (argv, phase, indeterminateOnFailure = false) => {
        const startedUtc = utcNow();
        let result;
        try { result = await spawnProcess(argv, { cwd, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.accountId }, shell: false, phase, timeoutMs: OPERATOR_TIMEOUT_MS }); }
        catch (error) { throw new Error(`${indeterminateOnFailure ? 'INDETERMINATE: ' : ''}operator.${phase}.spawn: ${error.message}`); }
        const finishedUtc = utcNow();
        const capturePath = path.join(config.operationalRoot, `${phase}.json`);
        try {
            await persistCapture(capturePath, result);
            return { result, capture: capture(capturePath, argv, cwd, result, startedUtc, finishedUtc) };
        }
        catch (error) { throw new Error(`${indeterminateOnFailure ? 'INDETERMINATE: ' : ''}operator.${phase}.capture: ${error.message}`); }
    };
    const campaignVerifierCapture = await runCampaignVerifier(config, deps, run);
    const sourceSnapshotTreeDigestAfter = treeDigest(config.sourceSnapshotDir, 'operator.source.tree');
    assertRootStable(config.sourceSnapshotDir, sourceSnapshotRealpathBefore, 'operator.source.root.mutable', sourceSnapshotIdentityBefore);
    assertRootStable(campaignInput.campaign, campaignRealpathBefore, 'operator.campaign.root.mutable', campaignIdentityBefore);
    const executionScriptsAfter = executionScriptHashes();
    const campaignTreeDigestAfter = treeDigest(campaignInput.campaign, 'operator.campaign.tree');
    if (sourceSnapshotTreeDigestAfter !== sourceSnapshotTreeDigestAfterVerifier) fail('operator.source.mutable');
    if (JSON.stringify(executionScriptsAfter) !== JSON.stringify(executionScriptsAfterVerifier)) fail('operator.executionSource.mutable');
    if (campaignTreeDigestAfter !== campaignTreeDigestAfterVerifier) fail('operator.campaign.mutable');
    assertAuthorityManifestStable(authority);
    assertIssuanceStable(identity.releaseIssuance, 'operator.identity.release.issuance.mutable');
    assertIssuanceStable(identity.campaignIssuance, 'operator.identity.campaign.issuance.mutable');
    await stageProductFiles(config, productFiles);
    const stagingRealpathBefore = fs.realpathSync(config.stagingDir);
    const stagingIdentityBefore = rootIdentity(config.stagingDir, 'operator.staging.root');
    const stagingTreeDigest = validateStagingTree(config.stagingDir, productFiles);
    const runOwnership = async (phase, indeterminate = false) => {
        assertRootStable(config.stagingDir, stagingRealpathBefore, `operator.${phase}.staging.root.mutable`, stagingIdentityBefore);
        validateStagingTree(config.stagingDir, productFiles);
        validateOperatorConfig(config);
        assertAuthorityManifestStable(authority);
        return run(buildOwnershipArgv(config), phase, indeterminate);
    };
    const pre = await runOwnership('pre');
    const preRows = parseRows(pre.result, 'pre').rows;
    const previous = validateOwnershipRow(preRows[0], config, 'operator.pre.ownership', config.sourceGitHead, false, allowNormalizedHarness);
    validateStagingTree(config.stagingDir, productFiles, 'operator.staging.beforeDeploy');
    assertPreExternalStable(config, { authority, identity, configBinding, productFiles, sourceSnapshotRealpath: sourceSnapshotRealpathBefore, sourceSnapshotIdentity: sourceSnapshotIdentityBefore, sourceSnapshotTreeDigest: sourceSnapshotTreeDigestAfter, executionScripts: executionScriptsAfter, campaignDir: campaignInput.campaign, campaignRealpath: campaignRealpathBefore, campaignIdentity: campaignIdentityBefore, campaignTreeDigest: campaignTreeDigestAfter, stagingRealpath: stagingRealpathBefore, stagingIdentity: stagingIdentityBefore, stagingTreeDigest });
    const deploy = await run(buildDeployArgv(config), 'deploy', true);
    const deployResult = normalizeResult(deploy.result);
    if (deployResult.timedOut || deployResult.exitCode !== 0 || deployResult.signal !== null) throw new Error('INDETERMINATE: operator.deploy');
    let post;
    let current;
    try {
        post = await runOwnership('post', true);
        const postRows = parseRows(post.result, 'post').rows;
        current = validateOwnershipRow(postRows[0], config, 'operator.post.ownership', config.sourceGitHead, true, allowNormalizedHarness);
    }
    catch (error) {
        if (String(error.message).startsWith('INDETERMINATE:')) throw error;
        throw new Error(`INDETERMINATE: operator.post: ${error.message}`);
    }
    if (current.Id === previous.Id) throw new Error('INDETERMINATE: operator.post.unchangedDeployment');
    try {
        validateOperatorConfig(config);
        assertRootStable(config.sourceSnapshotDir, sourceSnapshotRealpathBefore, 'operator.source.root.mutable', sourceSnapshotIdentityBefore);
        assertRootStable(campaignInput.campaign, campaignRealpathBefore, 'operator.campaign.root.mutable', campaignIdentityBefore);
        if (treeDigest(config.sourceSnapshotDir, 'operator.source.tree') !== sourceSnapshotTreeDigestAfter || JSON.stringify(executionScriptHashes()) !== JSON.stringify(executionScriptsAfter) || treeDigest(campaignInput.campaign, 'operator.campaign.tree') !== campaignTreeDigestAfter) fail('operator.post.mutable');
        assertAuthorityManifestStable(authority);
        assertIssuanceStable(identity.releaseIssuance, 'operator.identity.release.issuance.mutable');
        assertIssuanceStable(identity.campaignIssuance, 'operator.identity.campaign.issuance.mutable');
        assertIdentityLocksStable(identity, 'operator.identity.lock.mutable');
        assertConfigSourceStable(configBinding, config);
        assertRootStable(config.stagingDir, stagingRealpathBefore, 'operator.staging.root.mutable', stagingIdentityBefore);
        validateStagingTree(config.stagingDir, productFiles, 'operator.staging.post');
    } catch (error) { throw new Error(`INDETERMINATE: operator.post.mutable: ${error.message}`); }
    const record = deploymentRecord(config, current, productFiles, allowNormalizedHarness);
    const recordBytes = jsonBytes(record);
    const sourceFreezeSha256 = sha256File(config.sourceFreezePath);
    const receipt = { schemaVersion: 1, operation: 'deploy', releaseId: config.releaseId, campaignRunId: config.campaignRunId, projectName: config.projectName, accountId: config.accountId, environment: config.environment, branch: config.branch, sourceGitHead: config.sourceGitHead, sourceGitTree: config.sourceGitTree, authorityRootRealpath: authority.rootRealpath, authorityManifestPath: authority.path, authorityManifestRealpath: authority.realpath, authorityManifestBytes: authority.bytes, authorityManifestSha256: authority.sha256, releaseIssuancePath: identity.releaseIssuance.path, releaseIssuanceRealpath: identity.releaseIssuance.realpath, releaseIssuanceBytes: identity.releaseIssuance.bytes, releaseIssuanceSha256: identity.releaseIssuance.sha256, campaignIssuancePath: identity.campaignIssuance.path, campaignIssuanceRealpath: identity.campaignIssuance.realpath, campaignIssuanceBytes: identity.campaignIssuance.bytes, campaignIssuanceSha256: identity.campaignIssuance.sha256, configBinding, operatorPath: fileURLToPath(import.meta.url), operatorRealpath: fs.realpathSync(fileURLToPath(import.meta.url)), operatorSha256: sha256File(fileURLToPath(import.meta.url)), executionScripts: executionScriptHashes(), sourceFreezePath: path.resolve(config.sourceFreezePath), sourceFreezeSha256, sourceSnapshotDir: path.resolve(config.sourceSnapshotDir), sourceSnapshotRealpath: fs.realpathSync(config.sourceSnapshotDir), sourceSnapshotTreeDigest: sourceSnapshotTreeDigestAfter, campaignTreeDigest: campaignTreeDigestAfter, campaignDir: path.resolve(campaignInput.campaign), campaignRealpath: fs.realpathSync(campaignInput.campaign), campaignSpecPath: campaignInput.campaignSpecPath, campaignSpecBytes: campaignInput.campaignSpecBytes, campaignSpecSha256: campaignInput.campaignSpecSha256, campaignReceiptPath: path.resolve(config.campaignReceiptPath), campaignReceiptSha256: campaignInput.campaignReceiptSha256, campaignClaimsSha256: sha256File(path.join(campaignInput.campaign, 'claims.json')), campaignEnvelopeSha256: sha256File(path.join(campaignInput.campaign, 'submission-envelope.json')), campaignCandidateInventorySha256: sha256File(path.join(campaignInput.campaign, 'candidate-inventory.json')), campaignVerifierPath: path.join(config.sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs'), campaignVerifierSha256: sha256File(path.join(config.sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs')), nodeExePath: config.nodeExePath, nodeExeRealpath: fs.realpathSync(config.nodeExePath), nodeExeSha256: config.nodeExeSha256, wranglerJsPath: config.wranglerJsPath, wranglerJsRealpath: fs.realpathSync(config.wranglerJsPath), wranglerJsSha256: config.wranglerJsSha256, stagingDir: path.resolve(config.stagingDir), stagingRealpath: fs.realpathSync(config.stagingDir), stagingTreeDigest, deploymentRecordPath: path.resolve(config.deploymentRecordPath), deploymentRecordBytes: recordBytes.length, deploymentRecordSha256: sha256Bytes(recordBytes), deploymentId: current.Id, immutableUrl: current.Deployment, aliasUrl: config.aliasUrl, campaignVerifierCapture, preOwnership: pre.capture, deployCapture: deploy.capture, postOwnership: post.capture, createdUtc: utcNow() };
    Object.assign(receipt, identityLockReceiptFields(identity));
    try {
        await writeJsonExclusive(config.deploymentRecordPath, record);
        const publishedRecord = fs.readFileSync(config.deploymentRecordPath);
        if (!publishedRecord.equals(recordBytes)) throw new Error('deploymentRecord bytes changed');
    } catch (error) {
        throw new Error(`INDETERMINATE: operator.publication: ${error.message}`);
    }
    try {
        validateOperatorConfig(config);
        assertRootStable(config.sourceSnapshotDir, sourceSnapshotRealpathBefore, 'operator.source.root.mutable', sourceSnapshotIdentityBefore);
        assertRootStable(campaignInput.campaign, campaignRealpathBefore, 'operator.campaign.root.mutable', campaignIdentityBefore);
        if (treeDigest(config.sourceSnapshotDir, 'operator.source.tree') !== sourceSnapshotTreeDigestAfter || JSON.stringify(executionScriptHashes()) !== JSON.stringify(executionScriptsAfter) || treeDigest(campaignInput.campaign, 'operator.campaign.tree') !== campaignTreeDigestAfter) fail('operator.publication.mutable');
        assertAuthorityManifestStable(authority);
        assertIssuanceStable(identity.releaseIssuance, 'operator.identity.release.issuance.mutable');
        assertIssuanceStable(identity.campaignIssuance, 'operator.identity.campaign.issuance.mutable');
        assertIdentityLocksStable(identity, 'operator.identity.lock.mutable');
        assertConfigSourceStable(configBinding, config);
        assertRootStable(config.stagingDir, stagingRealpathBefore, 'operator.staging.root.mutable', stagingIdentityBefore);
        validateStagingTree(config.stagingDir, productFiles, 'operator.staging.publication');
        for (const commandCapture of [campaignVerifierCapture, pre.capture, deploy.capture, post.capture]) assertCaptureStable(commandCapture, config.operationalRoot, 'operator.capture.mutable');
    } catch (error) { throw new Error(`INDETERMINATE: operator.publication.fence: ${error.message}`); }
    try { writeJsonExclusiveSync(config.deploymentReceiptPath, receipt); }
    catch (error) { throw new Error(`INDETERMINATE: operator.publication: ${error.message}`); }
    return { status: 'DEPLOYED', record, receipt };
}

async function runRollback(config, deps) {
    const allowNormalizedHarness = deps.allowNormalizedOwnershipRows === true;
    const authority = validateAuthorityManifest(config);
    const configBinding = validateConfigSource(deps.configSource, config, authority);
    const identity = await acquireIdentityLocks(config, authority, configBinding);
    await acquireLaunchLock(config);
    validateSourceSnapshot(config);
    const sourceSnapshotRealpathBefore = fs.realpathSync(config.sourceSnapshotDir);
    const sourceSnapshotIdentityBefore = rootIdentity(config.sourceSnapshotDir, 'operator.source.root');
    const sourceSnapshotTreeDigestBefore = treeDigest(config.sourceSnapshotDir, 'operator.source.tree');
    const executionScriptsBefore = executionScriptHashes();
    if (!fs.existsSync(config.rollbackBaselinePath) || fs.lstatSync(config.rollbackBaselinePath).isSymbolicLink()) fail('rollback.baseline');
    let baseline;
    try { baseline = JSON.parse(fs.readFileSync(config.rollbackBaselinePath, 'utf8')); } catch { fail('rollback.baseline'); }
    const productFiles = validateRollbackBaseline(config, baseline);
    for (const output of [config.baselineRoot, config.deploymentReceiptPath, config.deploymentRecordPath, path.join(config.operationalRoot, 'rollback.json.stdout.bin'), path.join(config.operationalRoot, 'rollback.json.stderr.bin')]) if (pathExists(output)) fail('RELEASE_ID_CONSUMED');
    await fsp.mkdir(config.baselineRoot, { recursive: true });
    const baselineFiles = {};
    const baselineSourceRoot = path.join(path.dirname(config.rollbackBaselinePath), 'baseline');
    const baselineRecordBytesBefore = Buffer.from(fs.readFileSync(config.rollbackBaselinePath));
    for (const [publicPath, [name]] of Object.entries(PRODUCT_FILES)) {
        const source = path.join(path.dirname(config.rollbackBaselinePath), 'baseline', name);
        if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isFile() || fs.statSync(source).size !== productFiles[publicPath].bytes || sha256File(source) !== productFiles[publicPath].sha256) fail('rollback.baseline.bytes');
        baselineFiles[name] = { bytes: fs.statSync(source).size, sha256: sha256File(source) };
        await fsp.copyFile(source, path.join(config.baselineRoot, name), fs.constants.COPYFILE_EXCL);
    }
    const expectedBaselineNames = Object.values(PRODUCT_FILES).map(([name]) => name).sort();
    if (JSON.stringify(regularFiles(baselineSourceRoot, 'rollback.baseline.tree')) !== JSON.stringify(expectedBaselineNames)) fail('rollback.baseline.tree.membership');
    const baselineTreeDigestBefore = treeDigest(baselineSourceRoot, 'rollback.baseline.tree');
    const baselineSourceRealpathBefore = fs.realpathSync(baselineSourceRoot);
    const baselineSourceIdentityBefore = rootIdentity(baselineSourceRoot, 'rollback.baseline.root');
    const baselineStageRealpathBefore = fs.realpathSync(config.baselineRoot);
    const baselineStageIdentityBefore = rootIdentity(config.baselineRoot, 'rollback.staging.root');
    if (!fs.readFileSync(config.rollbackBaselinePath).equals(baselineRecordBytesBefore) || treeDigest(baselineSourceRoot, 'rollback.baseline.tree') !== baselineTreeDigestBefore) fail('INDETERMINATE: rollback.baseline.mutable');
    assertRootStable(config.sourceSnapshotDir, sourceSnapshotRealpathBefore, 'operator.source.root.mutable', sourceSnapshotIdentityBefore);
    assertRootStable(baselineSourceRoot, baselineSourceRealpathBefore, 'INDETERMINATE: rollback.baseline.root.mutable', baselineSourceIdentityBefore);
    assertRootStable(config.baselineRoot, baselineStageRealpathBefore, 'INDETERMINATE: rollback.staging.root.mutable', baselineStageIdentityBefore);
    const sourceSnapshotTreeDigestAfter = treeDigest(config.sourceSnapshotDir, 'operator.source.tree');
    if (sourceSnapshotTreeDigestAfter !== sourceSnapshotTreeDigestBefore || JSON.stringify(executionScriptHashes()) !== JSON.stringify(executionScriptsBefore)) fail('operator.source.mutable');
    assertAuthorityManifestStable(authority);
    assertIssuanceStable(identity.releaseIssuance, 'operator.identity.release.issuance.mutable');
    assertIssuanceStable(identity.campaignIssuance, 'operator.identity.campaign.issuance.mutable');
    const baselineStageTreeDigest = validateStagingTree(config.baselineRoot, productFiles, 'rollback.staging');
    const spawnProcess = deps.spawnProcess ?? defaultSpawnProcess;
    const cwd = path.resolve(config.operationalRoot);
    const run = async (argv, phase) => {
        const startedUtc = utcNow();
        let result;
        try { result = await spawnProcess(argv, { cwd, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.accountId }, shell: false, phase, timeoutMs: OPERATOR_TIMEOUT_MS }); }
        catch (error) { throw new Error(`INDETERMINATE: rollback.${phase}.spawn: ${error.message}`); }
        const finishedUtc = utcNow();
        const capturePath = path.join(config.operationalRoot, `${phase}.json`);
        try {
            await persistCapture(capturePath, result);
            const normalized = normalizeResult(result);
            if (normalized.timedOut || normalized.exitCode !== 0 || normalized.signal !== null) throw new Error(`rollback.${phase}`);
            return { result, capture: capture(capturePath, argv, cwd, result, startedUtc, finishedUtc) };
        }
        catch (error) { throw new Error(`INDETERMINATE: rollback.${phase}: ${error.message}`); }
    };
    const rollbackFence = { authority, identity, configBinding, productFiles, sourceSnapshotRealpath: sourceSnapshotRealpathBefore, sourceSnapshotIdentity: sourceSnapshotIdentityBefore, sourceSnapshotTreeDigest: sourceSnapshotTreeDigestBefore, executionScripts: executionScriptsBefore, stagingDir: config.baselineRoot, stagingRealpath: baselineStageRealpathBefore, stagingIdentity: baselineStageIdentityBefore, stagingTreeDigest: baselineStageTreeDigest };
    assertPreExternalStable(config, rollbackFence);
    const pre = await run(buildOwnershipArgv(config), 'rollback-pre');
    const preRow = validateOwnershipRow(parseRows(pre.result, 'rollback-pre').rows[0], config, 'rollback.pre.ownership', config.sourceGitHead, false, allowNormalizedHarness);
    if (preRow.Id === baseline.deploymentId || preRow.Deployment === baseline.immutableUrl) fail('rollback.pre.alreadyBaseline');
    assertPreExternalStable(config, rollbackFence);
    const rollback = await run(buildRollbackArgv(config, config.baselineRoot, baseline.sourceGitHead), 'rollback');
    let post;
    let postRow;
    try {
        post = await run(buildOwnershipArgv(config), 'rollback-post');
        postRow = validateOwnershipRow(parseRows(post.result, 'rollback-post').rows[0], config, 'rollback.post.ownership', baseline.sourceGitHead, true, allowNormalizedHarness);
        if (postRow.Id !== baseline.deploymentId || postRow.Deployment !== baseline.immutableUrl) fail('rollback.post.identity');
    }
    catch (error) {
        if (String(error.message).startsWith('INDETERMINATE:')) throw error;
        throw new Error(`INDETERMINATE: rollback.post: ${error.message}`);
    }
    try { validateOperatorConfig(config); }
    catch (error) { throw new Error(`INDETERMINATE: rollback.post.mutable: ${error.message}`); }
    if (!fs.readFileSync(config.rollbackBaselinePath).equals(baselineRecordBytesBefore) || treeDigest(baselineSourceRoot, 'rollback.baseline.tree') !== baselineTreeDigestBefore) fail('INDETERMINATE: rollback.baseline.mutable');
    assertRootStable(config.sourceSnapshotDir, sourceSnapshotRealpathBefore, 'INDETERMINATE: rollback.source.root.mutable', sourceSnapshotIdentityBefore);
    assertRootStable(baselineSourceRoot, baselineSourceRealpathBefore, 'INDETERMINATE: rollback.baseline.root.mutable', baselineSourceIdentityBefore);
    assertRootStable(config.baselineRoot, baselineStageRealpathBefore, 'INDETERMINATE: rollback.staging.root.mutable', baselineStageIdentityBefore);
    if (treeDigest(config.sourceSnapshotDir, 'rollback.source.tree') !== sourceSnapshotTreeDigestBefore || JSON.stringify(executionScriptHashes()) !== JSON.stringify(executionScriptsBefore)) fail('INDETERMINATE: rollback.source.mutable');
    assertAuthorityManifestStable(authority);
    assertIssuanceStable(identity.releaseIssuance, 'INDETERMINATE: rollback.identity.release.issuance.mutable');
    assertIssuanceStable(identity.campaignIssuance, 'INDETERMINATE: rollback.identity.campaign.issuance.mutable');
    assertIdentityLocksStable(identity, 'INDETERMINATE: rollback.identity.lock.mutable');
    assertConfigSourceStable(configBinding, config);
    if (validateStagingTree(config.baselineRoot, productFiles, 'rollback.staging.post') !== baselineStageTreeDigest) fail('INDETERMINATE: rollback.staging.mutable');
    const baselineBytes = fs.readFileSync(config.rollbackBaselinePath);
    const receipt = { schemaVersion: 1, operation: 'rollback', releaseId: config.releaseId, campaignRunId: config.campaignRunId, projectName: config.projectName, accountId: config.accountId, environment: config.environment, branch: config.branch, sourceGitHead: baseline.sourceGitHead, sourceGitTree: baseline.sourceGitTree, authorityRootRealpath: authority.rootRealpath, authorityManifestPath: authority.path, authorityManifestRealpath: authority.realpath, authorityManifestBytes: authority.bytes, authorityManifestSha256: authority.sha256, releaseIssuancePath: identity.releaseIssuance.path, releaseIssuanceRealpath: identity.releaseIssuance.realpath, releaseIssuanceBytes: identity.releaseIssuance.bytes, releaseIssuanceSha256: identity.releaseIssuance.sha256, campaignIssuancePath: identity.campaignIssuance.path, campaignIssuanceRealpath: identity.campaignIssuance.realpath, campaignIssuanceBytes: identity.campaignIssuance.bytes, campaignIssuanceSha256: identity.campaignIssuance.sha256, configBinding, operatorPath: fileURLToPath(import.meta.url), operatorRealpath: fs.realpathSync(fileURLToPath(import.meta.url)), operatorSha256: sha256File(fileURLToPath(import.meta.url)), executionScripts: executionScriptHashes(), sourceSnapshotDir: path.resolve(config.sourceSnapshotDir), sourceSnapshotRealpath: fs.realpathSync(config.sourceSnapshotDir), sourceSnapshotTreeDigest: sourceSnapshotTreeDigestAfter, nodeExePath: config.nodeExePath, nodeExeRealpath: fs.realpathSync(config.nodeExePath), nodeExeSha256: config.nodeExeSha256, wranglerJsPath: config.wranglerJsPath, wranglerJsRealpath: fs.realpathSync(config.wranglerJsPath), wranglerJsSha256: config.wranglerJsSha256, rollbackBaselinePath: path.resolve(config.rollbackBaselinePath), baselineRecordBytes: baselineBytes.length, baselineRecordSha256: sha256Bytes(baselineBytes), baselineTreeDigest: baselineTreeDigestBefore, baselineStageTreeDigest, baselineFiles, baselineDeploymentId: baseline.deploymentId, baselineImmutableUrl: baseline.immutableUrl, baselineRoot: path.resolve(config.baselineRoot), baselineRealpath: fs.realpathSync(config.baselineRoot), preOwnership: pre.capture, preDeploymentId: preRow.Id, preDeploymentUrl: preRow.Deployment, capture: rollback.capture, postOwnership: post.capture, postDeploymentId: postRow.Id, postDeploymentUrl: postRow.Deployment, createdUtc: utcNow() };
    Object.assign(receipt, identityLockReceiptFields(identity));
    try {
        for (const commandCapture of [pre.capture, rollback.capture, post.capture]) assertCaptureStable(commandCapture, config.operationalRoot, 'rollback.capture.mutable');
    } catch (error) { throw new Error(`INDETERMINATE: rollback.post.capture: ${error.message}`); }
    try { writeJsonExclusiveSync(config.deploymentReceiptPath, receipt); }
    catch (error) { throw new Error(`INDETERMINATE: rollback.publication: ${error.message}`); }
    return { status: 'ROLLED_BACK', baseline, capture: rollback.capture, postOwnership: post.capture, receipt };
}

async function runOperatorInternal(config, deps, allowNormalizedOwnershipRows) {
    validateOperatorConfig(config);
    const internalDeps = { ...deps, allowNormalizedOwnershipRows };
    if (config.mode === 'rollback') return runRollback(config, internalDeps);
    return runDeploy(config, internalDeps);
}

export async function runOperator(config, deps = {}) {
    return runOperatorInternal(config, deps, false);
}

export async function runOperatorForHarness(config, deps = {}) {
    return runOperatorInternal(config, deps, true);
}

async function main() {
    const parsed = parseOperatorArgv(process.argv.slice(2));
    if (parsed.help) {
        process.stdout.write('usage: operator-deploy-public-smoke-v2.mjs --config <absolute-config.json> --mode <deploy|rollback>\n');
        return;
    }
    const { configPath, mode } = parsed;
    const configBytes = fs.readFileSync(configPath);
    const config = JSON.parse(configBytes.toString('utf8'));
    if (config.mode !== mode) fail('operator.mode');
    const authority = validateAuthorityManifest(config);
    const configSource = { path: configPath, bytes: configBytes.length, sha256: sha256Bytes(configBytes), objectSha256: sha256Bytes(jsonBytes(config)) };
    validateConfigSource(configSource, config, authority);
    const result = await runOperator(config, { configSource });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = error.message.startsWith('INDETERMINATE') ? 2 : 1; });
}
