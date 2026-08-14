import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PRODUCT_FILES = Object.freeze({
    '/': ['index.html', 'text/html'],
    '/content.js': ['content.js', 'application/javascript'],
    '/game-core.js': ['game-core.js', 'application/javascript'],
    '/script.js': ['script.js', 'application/javascript'],
    '/style.css': ['style.css', 'text/css'],
});

const CONFIG_KEYS = Object.freeze([
    'schemaVersion', 'mode', 'projectName', 'environment', 'branch', 'releaseId', 'campaignRunId',
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
const DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMMUTABLE_URL = /^https:\/\/[0-9a-f]{8}\.penguin-exit-0\.pages\.dev\/$/;
const ALIAS_URL = /^https:\/\/penguin-exit-0\.pages\.dev\/$/;
const APPROVED_SOURCE_HEAD = 'c25015dbc5c0aee847e2abc1ca1f9fb389e5b34b';
const APPROVED_SOURCE_TREE = '5dcc38f22ee66a8a351ef610449a293c1e2aadd4';
const APPROVED_PRODUCT_SHA = Object.freeze({
    '/': '09a5f080870d193c339a166e16d787b7753547b04b64431176dc12c750a48ab2',
    '/content.js': 'af63396a4a4c7c96730a1f8bb306b2c2bdf3386abe14a94649cd65bb3ae4067f',
    '/game-core.js': 'b3fad87bd4eee3c608e4e2944a3572df272646534d95aded3a1463ebe6d708a2',
    '/script.js': '84d39e465968cc65252e5239ef94bddb57e2e8421366fd876c8887c6ad99837b',
    '/style.css': '7b16c4a5956cc6babb7eb199bead9e66291f4b25cfd38673dee3e19d862f3c05',
});

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
    const candidate = path.resolve(string(value, invariant));
    if (!path.isAbsolute(candidate)) fail(invariant);
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
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? '');
    return { exitCode, signal, stdout, stderr };
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
    if (config.projectName !== 'penguin-exit-0' || config.environment !== 'Production' || config.branch !== 'main') fail('operator.config.project');
    if (!RELEASE_ID.test(string(config.releaseId, 'operator.config.releaseId')) || !CAMPAIGN_ID.test(string(config.campaignRunId, 'operator.config.campaignRunId'))) fail('operator.config.identity');
    if (config.sourceGitHead !== APPROVED_SOURCE_HEAD || config.sourceGitTree !== APPROVED_SOURCE_TREE) fail('operator.config.source');
    sha(config.nodeExeSha256, 'operator.config.nodeExeSha256'); sha(config.wranglerJsSha256, 'operator.config.wranglerJsSha256');
    if (!IMMUTABLE_URL.test(string(config.immutableUrl, 'operator.config.immutableUrl')) || !ALIAS_URL.test(string(config.aliasUrl, 'operator.config.aliasUrl'))) fail('operator.config.urls');
    for (const key of ['sourceSnapshotDir', 'sourceFreezePath', 'executionSourceDir', 'campaignDir', 'campaignSpecPath', 'campaignReceiptPath', 'authorityProjectRoot', 'authorityWorkspaceRoot', 'operationalRoot', 'stagingDir', 'baselineRoot', 'releaseRoot', 'deploymentRecordPath', 'deploymentReceiptPath', 'rollbackBaselinePath', 'nodeExePath', 'wranglerJsPath']) absolute(config[key], `operator.config.${key}`);
    noSymlinkAncestors(config.sourceSnapshotDir, 'operator.config.sourceSnapshot');
    noSymlinkAncestors(config.operationalRoot, 'operator.config.operationalRoot');
    noSymlinkAncestors(config.releaseRoot, 'operator.config.releaseRoot');
    validateToolFile(config.nodeExePath, config.nodeExeSha256, 'operator.config.nodeExe');
    validateToolFile(config.wranglerJsPath, config.wranglerJsSha256, 'operator.config.wranglerJs');
    contained(config.sourceSnapshotDir, config.sourceFreezePath, 'operator.config.sourceFreeze');
    if (path.resolve(config.stagingDir) === path.resolve(config.operationalRoot) || !path.resolve(config.stagingDir).startsWith(`${path.resolve(config.operationalRoot)}${path.sep}`)) fail('operator.config.staging');
    if (!path.resolve(config.deploymentRecordPath).startsWith(`${path.resolve(config.releaseRoot)}${path.sep}`)) fail('operator.config.record');
    if (!path.resolve(config.deploymentReceiptPath).startsWith(`${path.resolve(config.operationalRoot)}${path.sep}`)) fail('operator.config.receipt');
    for (const [left, right] of [[config.sourceSnapshotDir, config.operationalRoot], [config.sourceSnapshotDir, config.releaseRoot], [config.operationalRoot, config.releaseRoot]]) {
        const a = path.resolve(left); const b = path.resolve(right);
        if (a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)) fail('operator.config.roots');
    }
    return config;
}

function validateSourceSnapshot(config) {
    const sourceRoot = absolute(config.sourceSnapshotDir, 'operator.source.root');
    if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) fail('operator.source.snapshot');
    const freezePath = absolute(config.sourceFreezePath, 'operator.source.freeze');
    if (!fs.existsSync(freezePath) || fs.lstatSync(freezePath).isSymbolicLink()) fail('operator.source.freeze');
    let freeze;
    try { freeze = JSON.parse(fs.readFileSync(freezePath, 'utf8')); } catch { fail('operator.source.freeze'); }
    exactKeys(freeze, ['schemaVersion', 'sourceGitHead', 'sourceGitTree', 'operatorSha256', 'campaignVerifierSha256', 'nodeExeSha256', 'wranglerJsSha256'], 'operator.source.freeze');
    const verifierSnapshot = path.join(sourceRoot, 'scripts', 'verify-r10-campaign.mjs');
    const operatorPath = fileURLToPath(import.meta.url);
    const verifierHash = fs.existsSync(verifierSnapshot) && !fs.lstatSync(verifierSnapshot).isSymbolicLink() ? sha256File(verifierSnapshot) : null;
    if (freeze.schemaVersion !== 1 || freeze.sourceGitHead !== config.sourceGitHead || freeze.sourceGitTree !== config.sourceGitTree || freeze.operatorSha256 !== sha256File(operatorPath) || (verifierHash !== null && freeze.campaignVerifierSha256 !== verifierHash) || freeze.nodeExeSha256 !== config.nodeExeSha256 || freeze.wranglerJsSha256 !== config.wranglerJsSha256) fail('operator.source');
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
    return productFiles;
}

function validateCampaignInputs(config) {
    const campaign = absolute(config.campaignDir, 'operator.inputs.campaign');
    const required = [campaign, config.campaignSpecPath, config.campaignReceiptPath, path.join(campaign, 'claims.json'), path.join(campaign, 'submission-envelope.json')];
    if (required.some((file) => !fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink())) fail('operator.inputs.campaign');
    const verifierSnapshot = path.join(config.sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs');
    const verifierTemplate = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify-r14-campaign-v5.mjs');
    if (!fs.existsSync(verifierSnapshot) || fs.lstatSync(verifierSnapshot).isSymbolicLink() || !fs.existsSync(verifierTemplate) || sha256File(verifierSnapshot) !== sha256File(verifierTemplate)) fail('operator.inputs.campaignVerifier');
    return campaign;
}

function assertOutputsAbsent(config) {
    for (const output of outputPaths(config)) if (pathExists(output)) fail('RELEASE_ID_CONSUMED');
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
    return [config.nodeExePath, config.wranglerJsPath, 'pages', 'deployment', 'list', '--project-name', config.projectName, '--environment', 'production', '--json'];
}

function parseRows(result, phase) {
    const normalized = normalizeResult(result);
    if (normalized.exitCode !== 0 || normalized.signal !== null || normalized.stderr.length !== 0) fail(`operator.${phase}`);
    let rows;
    try { rows = JSON.parse(normalized.stdout.toString('utf8')); } catch { fail(`operator.${phase}.json`); }
    if (!Array.isArray(rows) || rows.length < 1) fail(`operator.${phase}.rows`);
    return { rows, normalized };
}

function validateOwnershipRow(row, config, invariant) {
    exactKeys(row, ['Id', 'Environment', 'Branch', 'Source', 'Deployment', 'Status', 'Build'], invariant);
    if (!DEPLOYMENT_ID.test(string(row.Id, `${invariant}.id`)) || row.Environment !== 'Production' || row.Branch !== 'main' || row.Source !== config.sourceGitHead.slice(0, 7) || !IMMUTABLE_URL.test(string(row.Deployment, `${invariant}.deployment`)) || row.Deployment !== `https://${row.Id.slice(0, 8)}.penguin-exit-0.pages.dev/`) fail(invariant);
    return row;
}

async function defaultSpawnProcess(argv, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout = [], stderr = [];
        child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
        child.once('error', reject);
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    });
}

async function writeJsonExclusive(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const descriptor = fs.openSync(file, 'wx');
    try {
        const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
        fs.writeFileSync(descriptor, bytes);
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

function deploymentRecord(config, row, productFiles) {
    validateOwnershipRow(row, config, 'operator.deploymentRecord');
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
    exactKeys(baseline, ['schemaVersion', 'projectName', 'environment', 'branch', 'deploymentId', 'immutableUrl', 'aliasUrl', 'sourceGitHead', 'productFiles', 'capturedUtc'], 'rollback.baseline');
    if (baseline.schemaVersion !== 1 || baseline.projectName !== config.projectName || baseline.environment !== 'Production' || baseline.branch !== 'main' || !DEPLOYMENT_ID.test(baseline.deploymentId) || !IMMUTABLE_URL.test(string(baseline.immutableUrl, 'rollback.baseline.immutableUrl')) || baseline.immutableUrl !== `https://${baseline.deploymentId.slice(0, 8)}.penguin-exit-0.pages.dev/` || baseline.aliasUrl !== config.aliasUrl || !SHA1.test(baseline.sourceGitHead) || Number.isNaN(Date.parse(string(baseline.capturedUtc, 'rollback.baseline.capturedUtc')))) fail('rollback.baseline');
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
    if (normalized.exitCode !== 0 || normalized.signal !== null || normalized.stderr.length !== 0 || normalized.stdout.toString('utf8') !== 'R10_CAMPAIGN_GATE=VERIFIED\n') fail('operator.campaignVerifier');
    return captured.capture;
}

async function runDeploy(config, deps) {
    assertOutputsAbsent(config);
    const productFiles = validateSourceSnapshot(config);
    validateCampaignInputs(config);
    const spawnProcess = deps.spawnProcess ?? defaultSpawnProcess;
    const cwd = path.resolve(config.operationalRoot);
    const run = async (argv, phase) => {
        const startedUtc = utcNow();
        let result;
        try { result = await spawnProcess(argv, { cwd, shell: false, phase }); }
        catch (error) { throw new Error(`INDETERMINATE: operator.${phase}.spawn: ${error.message}`); }
        const finishedUtc = utcNow();
        const capturePath = path.join(config.operationalRoot, `${phase}.json`);
        await persistCapture(capturePath, result);
        return { result, capture: capture(capturePath, argv, cwd, result, startedUtc, finishedUtc) };
    };
    const campaignVerifierCapture = await runCampaignVerifier(config, deps, run);
    await stageProductFiles(config, productFiles);
    const pre = await run(buildOwnershipArgv(config), 'pre');
    const preRows = parseRows(pre.result, 'pre').rows;
    const previous = validateOwnershipRow(preRows[0], config, 'operator.pre.ownership');
    const deploy = await run(buildDeployArgv(config), 'deploy');
    const deployResult = normalizeResult(deploy.result);
    if (deployResult.exitCode !== 0 || deployResult.signal !== null) throw new Error('INDETERMINATE: operator.deploy');
    const post = await run(buildOwnershipArgv(config), 'post');
    const postRows = parseRows(post.result, 'post').rows;
    const current = validateOwnershipRow(postRows[0], config, 'operator.post.ownership');
    if (current.Id === previous.Id) throw new Error('INDETERMINATE: operator.post.unchangedDeployment');
    const record = deploymentRecord(config, current, productFiles);
    const receipt = { schemaVersion: 1, operation: 'deploy', releaseId: config.releaseId, campaignRunId: config.campaignRunId, projectName: config.projectName, environment: config.environment, branch: config.branch, sourceGitHead: config.sourceGitHead, sourceGitTree: config.sourceGitTree, operatorPath: fileURLToPath(import.meta.url), operatorSha256: sha256File(fileURLToPath(import.meta.url)), campaignVerifierPath: path.join(config.sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs'), campaignVerifierSha256: sha256File(path.join(config.sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs')), nodeExePath: config.nodeExePath, nodeExeSha256: config.nodeExeSha256, wranglerJsPath: config.wranglerJsPath, wranglerJsSha256: config.wranglerJsSha256, stagingDir: path.resolve(config.stagingDir), deploymentRecordPath: path.resolve(config.deploymentRecordPath), deploymentId: current.Id, immutableUrl: current.Deployment, aliasUrl: config.aliasUrl, campaignVerifierCapture, preOwnership: pre.capture, deployCapture: deploy.capture, postOwnership: post.capture, createdUtc: utcNow() };
    try {
        await writeJsonExclusive(config.deploymentRecordPath, record);
        await writeJsonExclusive(config.deploymentReceiptPath, receipt);
    } catch (error) {
        throw new Error(`INDETERMINATE: operator.publication: ${error.message}`);
    }
    return { status: 'DEPLOYED', record, receipt };
}

async function runRollback(config, deps) {
    if (!fs.existsSync(config.rollbackBaselinePath) || fs.lstatSync(config.rollbackBaselinePath).isSymbolicLink()) fail('rollback.baseline');
    let baseline;
    try { baseline = JSON.parse(fs.readFileSync(config.rollbackBaselinePath, 'utf8')); } catch { fail('rollback.baseline'); }
    const productFiles = validateRollbackBaseline(config, baseline);
    for (const output of [config.baselineRoot, config.deploymentReceiptPath, config.deploymentRecordPath, path.join(config.operationalRoot, 'rollback.json.stdout.bin'), path.join(config.operationalRoot, 'rollback.json.stderr.bin')]) if (pathExists(output)) fail('RELEASE_ID_CONSUMED');
    await fsp.mkdir(config.baselineRoot, { recursive: true });
    for (const [publicPath, [name]] of Object.entries(PRODUCT_FILES)) {
        const source = path.join(path.dirname(config.rollbackBaselinePath), 'baseline', name);
        if (!fs.existsSync(source) || sha256File(source) !== productFiles[publicPath].sha256) fail('rollback.baseline.bytes');
        await fsp.copyFile(source, path.join(config.baselineRoot, name), fs.constants.COPYFILE_EXCL);
    }
    const spawnProcess = deps.spawnProcess ?? defaultSpawnProcess;
    const argv = buildRollbackArgv(config, config.baselineRoot, baseline.sourceGitHead);
    const startedUtc = utcNow();
    let result;
    try { result = await spawnProcess(argv, { cwd: path.resolve(config.operationalRoot), shell: false, phase: 'rollback' }); }
    catch (error) { throw new Error(`INDETERMINATE: rollback.spawn: ${error.message}`); }
    const finishedUtc = utcNow();
    const captureData = capture(path.join(config.operationalRoot, 'rollback.json'), argv, path.resolve(config.operationalRoot), result, startedUtc, finishedUtc);
    try { await persistCapture(path.join(config.operationalRoot, 'rollback.json'), result); }
    catch (error) { throw new Error(`INDETERMINATE: rollback.capture: ${error.message}`); }
    const normalized = normalizeResult(result);
    if (normalized.exitCode !== 0 || normalized.signal !== null) throw new Error('INDETERMINATE: rollback');
    const receipt = { schemaVersion: 1, operation: 'rollback', releaseId: config.releaseId, campaignRunId: config.campaignRunId, projectName: config.projectName, environment: config.environment, branch: config.branch, sourceGitHead: baseline.sourceGitHead, sourceGitTree: config.sourceGitTree, operatorPath: fileURLToPath(import.meta.url), operatorSha256: sha256File(fileURLToPath(import.meta.url)), nodeExePath: config.nodeExePath, nodeExeSha256: config.nodeExeSha256, wranglerJsPath: config.wranglerJsPath, wranglerJsSha256: config.wranglerJsSha256, rollbackBaselinePath: path.resolve(config.rollbackBaselinePath), baselineDeploymentId: baseline.deploymentId, baselineRoot: path.resolve(config.baselineRoot), capture: captureData, createdUtc: utcNow() };
    try { await writeJsonExclusive(config.deploymentReceiptPath, receipt); }
    catch (error) { throw new Error(`INDETERMINATE: rollback.publication: ${error.message}`); }
    return { status: 'ROLLED_BACK', baseline, capture: captureData, receipt };
}

export async function runOperator(config, deps = {}) {
    validateOperatorConfig(config);
    if (config.mode === 'rollback') return runRollback(config, deps);
    return runDeploy(config, deps);
}

async function main() {
    const parsed = parseOperatorArgv(process.argv.slice(2));
    if (parsed.help) {
        process.stdout.write('usage: operator-deploy-public-smoke-v2.mjs --config <absolute-config.json> --mode <deploy|rollback>\n');
        return;
    }
    const { configPath, mode } = parsed;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.mode !== mode) fail('operator.mode');
    const result = await runOperator(config);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = error.message.startsWith('INDETERMINATE') ? 2 : 1; });
}
