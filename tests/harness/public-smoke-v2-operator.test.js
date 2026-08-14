import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const OPERATOR_MODULE = '../../scripts/operator-deploy-public-smoke-v2.mjs';
const APPROVED_HEAD = 'c25015dbc5c0aee847e2abc1ca1f9fb389e5b34b';
const APPROVED_TREE = '5dcc38f22ee66a8a351ef610449a293c1e2aadd4';
const APPROVED_SNAPSHOT_SCRIPTS = [
    'scripts/public-smoke-v2-lib.mjs',
    'scripts/run-public-smoke-v2.mjs',
    'scripts/run-public-smoke-v2-operation.mjs',
    'scripts/run-public-smoke-v2-negative-controls.mjs',
    'scripts/close-public-smoke-v2.mjs',
    'scripts/finalize-public-smoke-v2.mjs',
    'scripts/verify-public-smoke-v2.mjs',
    'scripts/verify-r10-campaign.mjs',
];

async function loadOperator() {
    return import(OPERATOR_MODULE);
}

async function makeFixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'r14-task7-operator-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourceSnapshotDir = path.join(root, 'source-snapshot');
    const operationalRoot = path.join(root, 'operations');
    const releaseRoot = path.join(root, 'release');
    const campaignDir = path.join(root, 'campaign-v5');
    const identityAuthorityRoot = path.join(root, 'identity-authority');
    await fs.mkdir(path.join(sourceSnapshotDir, 'scripts'), { recursive: true });
    await fs.mkdir(operationalRoot, { recursive: true });
    await fs.mkdir(releaseRoot, { recursive: true });
    await fs.mkdir(campaignDir, { recursive: true });
    await fs.mkdir(identityAuthorityRoot, { recursive: true });
    const previousIdentityAuthority = process.env.R14_TASK7_IDENTITY_AUTHORITY_ROOT;
    process.env.R14_TASK7_IDENTITY_AUTHORITY_ROOT = identityAuthorityRoot;
    t.after(() => {
        if (previousIdentityAuthority === undefined) delete process.env.R14_TASK7_IDENTITY_AUTHORITY_ROOT;
        else process.env.R14_TASK7_IDENTITY_AUTHORITY_ROOT = previousIdentityAuthority;
    });
    const product = {
        '/': ['index.html', 'text/html', '<!doctype html>\n'],
        '/content.js': ['content.js', 'application/javascript', 'content\n'],
        '/game-core.js': ['game-core.js', 'application/javascript', 'core\n'],
        '/script.js': ['script.js', 'application/javascript', 'script\n'],
        '/style.css': ['style.css', 'text/css', 'style\n'],
    };
    for (const [, [name]] of Object.entries(product)) await fs.copyFile(path.resolve(name), path.join(sourceSnapshotDir, name));
    for (const relative of APPROVED_SNAPSHOT_SCRIPTS) {
        await fs.mkdir(path.dirname(path.join(sourceSnapshotDir, relative)), { recursive: true });
        const source = relative === 'scripts/verify-r10-campaign.mjs' ? path.resolve('scripts/verify-r14-campaign-v5.mjs') : path.resolve(relative);
        await fs.copyFile(source, path.join(sourceSnapshotDir, relative));
    }
    const sourceFreezePath = path.join(sourceSnapshotDir, 'source-freeze.json');
    const wranglerJsPath = path.join(root, 'wrangler.js');
    await fs.writeFile(wranglerJsPath, '# fake pinned wrangler\n');
    const digest = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
    const nodeExeSha256 = await digest(process.execPath);
    const wranglerJsSha256 = await digest(wranglerJsPath);
    const sourceFiles = Object.fromEntries(await Promise.all(APPROVED_SNAPSHOT_SCRIPTS.map(async (relative) => [relative, await digest(path.join(sourceSnapshotDir, relative))])));
    await fs.writeFile(sourceFreezePath, JSON.stringify({ schemaVersion: 1, sourceGitHead: APPROVED_HEAD, sourceGitTree: APPROVED_TREE, operatorSha256: await digest(path.resolve('scripts/operator-deploy-public-smoke-v2.mjs')), campaignVerifierSha256: sourceFiles['scripts/verify-r10-campaign.mjs'], nodeExeSha256, wranglerJsSha256, sourceFiles }) + '\n');
    const authorityManifestPath = path.join(identityAuthorityRoot, 'authority-manifest.json');
    await fs.writeFile(authorityManifestPath, JSON.stringify({ schemaVersion: 1, projectName: 'penguin-exit-0', accountId: '0123456789abcdef0123456789abcdef', sourceGitHead: APPROVED_HEAD, sourceGitTree: APPROVED_TREE, nodeExeSha256, wranglerJsSha256, operatorSha256: await digest(path.resolve('scripts/operator-deploy-public-smoke-v2.mjs')), campaignVerifierSha256: sourceFiles['scripts/verify-r10-campaign.mjs'], createdUtc: new Date().toISOString() }) + '\n');
    const authorityManifestSha256 = await digest(authorityManifestPath);
    const config = {
        schemaVersion: 1,
        mode: 'deploy',
        projectName: 'penguin-exit-0',
        accountId: '0123456789abcdef0123456789abcdef',
        environment: 'Production',
        branch: 'main',
        releaseId: '20260815T120000Z-r14-public-smoke-v2',
        campaignRunId: '20260815T120000Z-r10-korean-release',
        sourceGitHead: APPROVED_HEAD,
        sourceGitTree: APPROVED_TREE,
        sourceSnapshotDir,
        sourceFreezePath,
        campaignDir,
        campaignSpecPath: path.join(campaignDir, 'spec.json'),
        campaignReceiptPath: path.join(campaignDir, 'campaign-receipt.json'),
        executionSourceDir: root,
        authorityProjectRoot: root,
        authorityWorkspaceRoot: root,
        operationalRoot,
        stagingDir: path.join(operationalRoot, 'staging'),
        baselineRoot: path.join(operationalRoot, 'baseline'),
        releaseRoot,
        deploymentRecordPath: path.join(releaseRoot, 'deployment-record.json'),
        deploymentReceiptPath: path.join(operationalRoot, 'operator-deployment-receipt.json'),
        rollbackBaselinePath: path.join(operationalRoot, 'rollback-baseline.json'),
        nodeExePath: process.execPath,
        nodeExeSha256,
        wranglerJsPath,
        wranglerJsSha256,
        immutableUrl: 'https://11111111.penguin-exit-0.pages.dev/',
        aliasUrl: 'https://penguin-exit-0.pages.dev/',
    };
    for (const [kind, id] of [['release', config.releaseId], ['campaign', config.campaignRunId]]) {
        const issuancePath = path.join(identityAuthorityRoot, 'issuance', kind, `${id}.json`);
        await fs.mkdir(path.dirname(issuancePath), { recursive: true });
        await fs.writeFile(issuancePath, JSON.stringify({ schemaVersion: 1, kind, id, projectName: config.projectName, accountId: config.accountId, sourceGitHead: config.sourceGitHead, sourceGitTree: config.sourceGitTree, issuedUtc: new Date().toISOString(), authorityManifestSha256 }) + '\n');
    }
    return { root, sourceSnapshotDir, operationalRoot, releaseRoot, identityAuthorityRoot, product, config };
}

async function completeCampaign(fixture) {
    await fs.writeFile(fixture.config.campaignSpecPath, '{}\n');
    await fs.writeFile(fixture.config.campaignReceiptPath, '{}\n');
    await fs.writeFile(path.join(fixture.config.campaignDir, 'claims.json'), '{}\n');
    await fs.writeFile(path.join(fixture.config.campaignDir, 'submission-envelope.json'), '{}\n');
    await fs.writeFile(path.join(fixture.config.campaignDir, 'candidate-inventory.json'), '{}\n');
    await fs.copyFile(path.resolve('scripts/verify-r14-campaign-v5.mjs'), path.join(fixture.config.sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs'));
}

async function completeValidCampaign(fixture) {
    const campaignDir = fixture.config.campaignDir;
    const sourceRoot = fixture.config.sourceSnapshotDir;
    const runId = fixture.config.campaignRunId;
    const json = (value) => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
    const hashFile = async (file) => hash(await fs.readFile(file));
    const listFiles = async (directory, relative = '') => {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        const files = [];
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            const entryRelative = path.join(relative, entry.name).split(path.sep).join('/');
            if (entry.isDirectory()) files.push(...await listFiles(entryPath, entryRelative));
            else files.push(entryRelative);
        }
        return files.sort((left, right) => left.localeCompare(right, 'en'));
    };
    await fs.writeFile(fixture.config.campaignSpecPath, '# campaign-v5\n');
    const sourcePaths = await listFiles(sourceRoot);
    const inventoryFiles = await Promise.all(sourcePaths.map(async (relative) => {
        const bytes = await fs.readFile(path.join(sourceRoot, ...relative.split('/')));
        return { path: relative, sizeBytes: bytes.length, sha256: hash(bytes) };
    }));
    const inventory = {
        schemaVersion: 1,
        algorithm: 'SHA-256',
        pathEncoding: 'UTF-8 NUL-terminated ordered path records',
        fileCount: inventoryFiles.length,
        pathListSha256: hash(Buffer.from(inventoryFiles.map((entry) => `${entry.path}\0`).join(''), 'utf8')),
        contentRecordsSha256: hash(Buffer.from(inventoryFiles.map((entry) => `${entry.path}\0${entry.sizeBytes}\0${entry.sha256}\0`).join(''), 'utf8')),
        files: inventoryFiles,
    };
    const write = async (file, value) => { await fs.writeFile(file, json(value)); };
    await write(path.join(campaignDir, 'artifact-manifest.json'), []);
    await write(path.join(campaignDir, 'candidate-inventory.json'), inventory);
    await fs.writeFile(path.join(campaignDir, 'ledger.jsonl'), `${JSON.stringify({ schemaVersion: 5, runId, state: 'VERIFIED' })}\n`);
    for (const name of ['r9-before.json', 'r9-after.json', 'r10-before.json', 'r10-after.json']) await write(path.join(campaignDir, name), { frozen: name });
    await fs.writeFile(path.join(campaignDir, 'performance-summary.json'), '{"summary":true}\n');
    await fs.writeFile(path.join(campaignDir, 'frame-samples.json'), '[1]\n');
    const frozen = { fileCount: 1, pathListSha256: hash(Buffer.from('frozen\0')), beforeDigest: hash(Buffer.from('frozen')), afterDigest: hash(Buffer.from('frozen')) };
    const r10Frozen = { fileCount: 1, pathListSha256: hash(Buffer.from('r10\0')), beforeDigest: hash(Buffer.from('r10')), afterDigest: hash(Buffer.from('r10')) };
    const claims = {
        schemaVersion: 5,
        runId,
        v1Sha256: hash(Buffer.from('v1')),
        candidateInventory: { fileCount: inventory.fileCount, pathListSha256: inventory.pathListSha256, contentRecordsSha256: inventory.contentRecordsSha256 },
        gameCoreSha256: await hashFile(path.join(sourceRoot, 'game-core.js')),
        sourceGit: { branch: 'main', headSha: fixture.config.sourceGitHead },
        unit: { tests: 29, passed: 29, failed: 0, exitCode: 0 },
        browser: { chromium: { passed: 16, failed: 0 }, firefox: { passed: 16, failed: 0 }, webkit: { passed: 16, failed: 0 }, integrity: true, reportedFailures: 0, exitCode: 0 },
        performance: { startedUtc: new Date(Date.now() - 600000).toISOString(), endedUtc: new Date(Date.now() - 1000).toISOString(), measuredDurationMs: 599000, environment: { nodeVersion: 'v22.21.1', platform: 'win32', arch: 'x64', project: 'chromium-perf' }, sampleCount: 100, rawMinMs: 1, rawMaxMs: 20, p50LatencyMs: 10, p95LatencyMs: 18, p99LatencyMs: 20, longTaskObserverSupported: true, longTasksCount: 0, heapStartMb: 1, heapEndMb: 2, heapNetGrowthMb: 1, totalActionsCount: 100 },
        negativeControls: { passed: 12, total: 12, failed: 0, exitCode: 0 },
        campaignVerifier: { tests: 1, passed: 1, failed: 0, exitCode: 0 },
        r9Frozen: frozen,
        r10Frozen,
        actualBrowserZoom: { claimed: false, equivalentReflow: 'fixture only', limitation: 'actual browser chrome zoom not claimed' },
    };
    await write(path.join(campaignDir, 'claims.json'), claims);
    const payloadNames = ['artifact-manifest.json', 'candidate-inventory.json', 'claims.json', 'ledger.jsonl', 'r9-before.json', 'r9-after.json', 'r10-before.json', 'r10-after.json'];
    const envelope = {
        schemaVersion: 5,
        runId,
        payloadHashes: Object.fromEntries(await Promise.all(payloadNames.map(async (name) => [name, await hashFile(path.join(campaignDir, name))]))),
        source: { path: 'source-snapshot', fileCount: inventory.fileCount, pathListSha256: inventory.pathListSha256, contentRecordsSha256: inventory.contentRecordsSha256, gitBranch: 'main', gitHeadSha: fixture.config.sourceGitHead },
        spec: { fileName: path.basename(fixture.config.campaignSpecPath), sizeBytes: (await fs.stat(fixture.config.campaignSpecPath)).size, sha256: await hashFile(fixture.config.campaignSpecPath) },
        rawEvidence: { summary: { path: 'performance-summary.json', sha256: await hashFile(path.join(campaignDir, 'performance-summary.json')) }, samples: { path: 'frame-samples.json', sha256: await hashFile(path.join(campaignDir, 'frame-samples.json')) } },
    };
    await write(path.join(campaignDir, 'submission-envelope.json'), envelope);
    const command = { key: 'unit', argv: [process.execPath, '--test'], cwd: fixture.root, startedUtc: new Date(Date.now() - 10000).toISOString(), endedUtc: new Date(Date.now() - 9000).toISOString(), timeoutMs: 120000, timedOut: false, exitCode: 0, signal: null, stdoutPath: 'commands/unit.stdout.log', stdoutSha256: hash(Buffer.from('ok\n')), stderrPath: 'commands/unit.stderr.log', stderrSha256: hash(Buffer.alloc(0)) };
    const receipt = {
        schemaVersion: 1,
        runId,
        status: 'VERIFIED',
        createdUtc: new Date(Date.now() - 700000).toISOString(),
        completedUtc: new Date(Date.now() - 500).toISOString(),
        projectRoot: fixture.root,
        cleanRoot: fixture.root,
        campaign: { path: campaignDir, artifactManifestSha256: await hashFile(path.join(campaignDir, 'artifact-manifest.json')), submissionEnvelopeSha256: await hashFile(path.join(campaignDir, 'submission-envelope.json')) },
        spec: { path: fixture.config.campaignSpecPath, sizeBytes: (await fs.stat(fixture.config.campaignSpecPath)).size, sha256: await hashFile(fixture.config.campaignSpecPath) },
        candidateInventory: claims.candidateInventory,
        gameCoreSha256: claims.gameCoreSha256,
        sourceGit: claims.sourceGit,
        r9Frozen: claims.r9Frozen,
        r10Frozen: claims.r10Frozen,
        commands: [command],
        limitation: claims.actualBrowserZoom,
        publicationState: 'COMMITTED only when operation SUCCESS.json exists',
    };
    await fs.mkdir(path.join(campaignDir, 'commands'), { recursive: true });
    await fs.writeFile(path.join(campaignDir, 'commands', 'unit.stdout.log'), 'ok\n');
    await fs.writeFile(path.join(campaignDir, 'commands', 'unit.stderr.log'), '');
    await write(path.join(campaignDir, 'campaign-receipt.json'), receipt);
}

test('operator exposes source-bound deploy and rollback entrypoints', async () => {
    const operator = await loadOperator();
    assert.equal(typeof operator.validateOperatorConfig, 'function');
    assert.equal(typeof operator.buildDeployArgv, 'function');
    assert.equal(typeof operator.buildRollbackArgv, 'function');
    assert.equal(typeof operator.buildCampaignVerifierArgv, 'function');
    assert.equal(typeof operator.runOperator, 'function');
});

test('production campaign-v5 preflight rejects an incomplete fixture before the child gate', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    const operator = await loadOperator();
    const calls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, {
        spawnProcess: async (argv, options) => {
            calls.push({ argv, options });
            return { exitCode: 0, signal: null, stdout: Buffer.from('R10_CAMPAIGN_GATE=NO_GO reason=spoof\n'), stderr: Buffer.alloc(0) };
        },
    }), /operator\.inputs\.campaign/);
    assert.equal(calls.length, 0);
    await assert.rejects(fs.access(fixture.config.deploymentRecordPath));
});

test('production path validates campaign-v5 schema and digests before any child', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    const operator = await loadOperator();
    const calls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, {
        spawnProcess: async (...args) => { calls.push(args); return { exitCode: 0, signal: null, stdout: Buffer.from('R10_CAMPAIGN_GATE=VERIFIED\n'), stderr: Buffer.alloc(0) }; },
    }), /operator\.inputs\.campaign/);
    assert.equal(calls.length, 0);
});

test('campaign gate failure consumes the release id and forbids same-id retry', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    const operator = await loadOperator();
    const firstCalls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async () => { throw new Error('R10_CAMPAIGN_GATE=NO_GO\n'); },
        spawnProcess: async (...args) => {
            firstCalls.push(args);
            return { exitCode: 1, signal: null, stdout: Buffer.from('R10_CAMPAIGN_GATE=NO_GO\n'), stderr: Buffer.from('reason\n') };
        },
    }), /operator\.campaignVerifier/);
    assert.equal(firstCalls.length, 0);
    const secondCalls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, { spawnProcess: async (...args) => { secondCalls.push(args); } }), /RELEASE_ID_CONSUMED/);
    assert.equal(secondCalls.length, 0);
});

test('operator CLI help is a single machine-readable usage line', async () => {
    const operator = await loadOperator();
    assert.deepEqual(operator.parseOperatorArgv(['--help']), { help: true });
    assert.deepEqual(operator.parseOperatorArgv(['-h']), { help: true });
});

test('deploy preflight rejects missing campaign-v5 inputs before external invocation', async (t) => {
    const fixture = await makeFixture(t);
    const operator = await loadOperator();
    const calls = [];
    await assert.rejects(
        () => operator.runOperator(fixture.config, { spawnProcess: async (...args) => { calls.push(args); } }),
        /operator\.inputs\.campaign/,
    );
    assert.equal(calls.length, 0);
    assert.equal(await fs.stat(fixture.sourceSnapshotDir).then(() => true), true);
    await assert.rejects(fs.access(fixture.config.deploymentRecordPath));
});

test('deploy preflight rejects source commit-tree or exact-five drift before external invocation', async (t) => {
    const fixture = await makeFixture(t);
    const operator = await loadOperator();
    fixture.config.sourceGitTree = 'e'.repeat(40);
    const calls = [];
    await assert.rejects(
        () => operator.runOperator(fixture.config, { spawnProcess: async (...args) => { calls.push(args); } }),
        /operator\.(?:config\.)?source/,
    );
    assert.equal(calls.length, 0);
});

test('deploy preflight rejects a tool byte drift before campaign or external invocation', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    const operator = await loadOperator();
    fixture.config.wranglerJsSha256 = '0'.repeat(64);
    const campaignCalls = [];
    const calls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async (...args) => { campaignCalls.push(args); },
        spawnProcess: async (...args) => { calls.push(args); },
    }), /operator\.config\.wranglerJs\.sha256/);
    assert.equal(campaignCalls.length, 0);
    assert.equal(calls.length, 0);
});

test('deploy preflight rejects a Wrangler path below a symlink ancestor', async (t) => {
    const fixture = await makeFixture(t);
    const linkRoot = path.join(fixture.root, 'wrangler-link');
    await fs.symlink(fixture.root, linkRoot, 'junction');
    const operator = await loadOperator();
    fixture.config.wranglerJsPath = path.join(linkRoot, 'wrangler.js');
    const calls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, { spawnProcess: async (...args) => { calls.push(args); } }), /operator\.config\.wranglerJs/);
    assert.equal(calls.length, 0);
});

test('deploy preflight rejects a source-freeze script hash drift before campaign or external invocation', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    const freeze = JSON.parse(await fs.readFile(fixture.config.sourceFreezePath, 'utf8'));
    freeze.operatorSha256 = '0'.repeat(64);
    await fs.writeFile(fixture.config.sourceFreezePath, JSON.stringify(freeze) + '\n');
    const operator = await loadOperator();
    const campaignCalls = [];
    const calls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async (...args) => { campaignCalls.push(args); },
        spawnProcess: async (...args) => { calls.push(args); },
    }), /operator\.source/);
    assert.equal(campaignCalls.length, 0);
    assert.equal(calls.length, 0);
});

test('operator builds exact deploy argv with shell-free source binding', async (t) => {
    const fixture = await makeFixture(t);
    const operator = await loadOperator();
    const argv = operator.buildDeployArgv(fixture.config, fixture.config.stagingDir);
    assert.deepEqual(argv, [
        fixture.config.nodeExePath,
        fixture.config.wranglerJsPath,
        'pages', 'deploy', fixture.config.stagingDir,
        '--project-name', 'penguin-exit-0',
        '--branch', 'main',
        '--commit-hash', fixture.config.sourceGitHead,
        '--commit-dirty=false',
        '--no-bundle',
    ]);
});

test('operator builds a baseline rollback argv without mutating baseline', async (t) => {
    const fixture = await makeFixture(t);
    const operator = await loadOperator();
    const argv = operator.buildRollbackArgv(fixture.config, fixture.config.baselineRoot);
    assert.deepEqual(argv.slice(2, 6), ['pages', 'deploy', fixture.config.baselineRoot, '--project-name']);
    assert.equal(argv.includes('--commit-dirty=false'), true);
    assert.equal(argv.includes('--no-bundle'), true);
});

test('valid fake deploy writes exact schema-1 record and one-shot receipt', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    const operator = await loadOperator();
    const oldRow = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: fixture.config.immutableUrl, Status: 'success', Build: 'success' };
    const newRow = { ...oldRow, Id: '22222222-2222-4222-8222-222222222222', Deployment: 'https://22222222.penguin-exit-0.pages.dev/' };
    const calls = [];
    const campaignCalls = [];
    const result = await operator.runOperator(fixture.config, {
        runCampaignVerifier: async (config, argv) => { campaignCalls.push({ config, argv }); },
        spawnProcess: async (argv, options) => {
            calls.push({ argv, options });
            if (calls.length === 1) return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([oldRow])), stderr: Buffer.alloc(0) };
            if (calls.length === 2) return { exitCode: 0, signal: null, stdout: Buffer.from('upload-complete\n'), stderr: Buffer.alloc(0) };
            return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([newRow])), stderr: Buffer.alloc(0) };
        },
    });
    assert.equal(result.status, 'DEPLOYED');
    assert.equal(campaignCalls.length, 1);
    assert.deepEqual(campaignCalls[0].argv.slice(0, 2), [fixture.config.nodeExePath, path.join(fixture.config.sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs')]);
    assert.equal(calls.length, 3);
    assert.equal(calls[1].options.shell, false);
    assert.equal(calls[1].options.env.CLOUDFLARE_ACCOUNT_ID, fixture.config.accountId);
    assert.equal(calls[1].argv[2], 'pages');
    assert.equal(calls[1].argv[3], 'deploy');
    assert.equal(calls[1].argv.includes('--commit-dirty=false'), true);
    assert.deepEqual((await fs.readdir(fixture.config.stagingDir)).sort(), ['content.js', 'game-core.js', 'index.html', 'script.js', 'style.css']);
    const record = JSON.parse(await fs.readFile(fixture.config.deploymentRecordPath, 'utf8'));
    assert.deepEqual(Object.keys(record).sort(), ['aliasUrl', 'branch', 'capturedUtc', 'deploymentId', 'environment', 'immutableUrl', 'productFiles', 'projectName', 'schemaVersion', 'sourceGitHead'].sort());
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.deploymentId, newRow.Id);
    assert.deepEqual(Object.keys(record.productFiles).sort(), ['/', '/content.js', '/game-core.js', '/script.js', '/style.css'].sort());
    assert.equal((await fs.stat(fixture.config.deploymentReceiptPath)).isFile(), true);
    const receipt = JSON.parse(await fs.readFile(fixture.config.deploymentReceiptPath, 'utf8'));
    assert.equal(receipt.campaignVerifierCapture, null);
    assert.equal(receipt.nodeExeSha256, fixture.config.nodeExeSha256);
    assert.equal(receipt.wranglerJsSha256, fixture.config.wranglerJsSha256);
    assert.equal(receipt.authorityManifestBytes, (await fs.stat(path.join(fixture.identityAuthorityRoot, 'authority-manifest.json'))).size);
    assert.equal(receipt.authorityManifestRealpath, fsSync.realpathSync(path.join(fixture.identityAuthorityRoot, 'authority-manifest.json')));
    assert.equal(receipt.releaseIssuanceBytes > 0, true);
    assert.equal(receipt.campaignIssuanceBytes > 0, true);
    assert.equal(typeof receipt.releaseIssuanceRealpath, 'string');
    assert.equal(typeof receipt.campaignIssuanceRealpath, 'string');
    for (const kind of ['release', 'campaign']) {
        const prefix = `${kind}Lock`;
        assert.equal(typeof receipt[`${prefix}Path`], 'string');
        assert.equal(typeof receipt[`${prefix}Realpath`], 'string');
        assert.match(receipt[`${prefix}Identity`], /^\d+:\d+$/);
        assert.equal(typeof receipt[`${prefix}BindingPath`], 'string');
        assert.equal(typeof receipt[`${prefix}BindingRealpath`], 'string');
        const binding = await fs.readFile(receipt[`${prefix}BindingPath`]);
        assert.equal(receipt[`${prefix}BindingBytes`], binding.length);
        assert.equal(receipt[`${prefix}BindingSha256`], crypto.createHash('sha256').update(binding).digest('hex'));
    }
});

test('valid deploy runs the real campaign-v5 verifier path and binds its capture', async (t) => {
    const fixture = await makeFixture(t);
    const embeddedSource = path.join(fixture.config.campaignDir, 'source-snapshot');
    await fs.cp(fixture.sourceSnapshotDir, embeddedSource, { recursive: true });
    fixture.sourceSnapshotDir = embeddedSource;
    fixture.config.sourceSnapshotDir = embeddedSource;
    fixture.config.sourceFreezePath = path.join(embeddedSource, 'source-freeze.json');
    await completeValidCampaign(fixture);
    const operator = await loadOperator();
    const oldRow = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: fixture.config.immutableUrl, Status: 'success', Build: 'success' };
    const newRow = { ...oldRow, Id: '22222222-2222-4222-8222-222222222222', Deployment: 'https://22222222.penguin-exit-0.pages.dev/' };
    const calls = [];
    const result = await operator.runOperator(fixture.config, {
        spawnProcess: async (argv, options) => {
            calls.push({ argv, options });
            if (calls.length === 1) {
                const child = spawnSync(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, shell: false, windowsHide: true });
                return { exitCode: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr };
            }
            if (calls.length === 2) return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([oldRow])), stderr: Buffer.alloc(0) };
            if (calls.length === 3) return { exitCode: 0, signal: null, stdout: Buffer.from('upload-complete\n'), stderr: Buffer.alloc(0) };
            return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([newRow])), stderr: Buffer.alloc(0) };
        },
    });
    assert.equal(result.status, 'DEPLOYED');
    assert.equal(calls.length, 4);
    assert.equal(calls[0].argv[1].endsWith(path.join('scripts', 'verify-r10-campaign.mjs')), true);
    assert.equal(calls[0].options.shell, false);
    assert.equal(result.receipt.campaignVerifierCapture.exitCode, 0);
    assert.equal(result.receipt.campaignVerifierCapture.stdoutBytes, Buffer.byteLength('R10_CAMPAIGN_GATE=VERIFIED\n'));
    assert.equal(result.receipt.campaignVerifierCapture.stderrBytes, 0);
    assert.equal(result.receipt.campaignTreeDigest.length, 64);
});

test('campaign-v5 gate failure stops before any ownership or deploy request', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    const operator = await loadOperator();
    const calls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async () => { throw new Error('R10_CAMPAIGN_GATE=NO_GO reason=fixture'); },
        spawnProcess: async (...args) => { calls.push(args); },
    }), /operator\.campaignVerifier/);
    assert.equal(calls.length, 0);
    await assert.rejects(fs.access(fixture.config.deploymentRecordPath));
});

test('source product drift is rejected before campaign or external invocation', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    await fs.appendFile(path.join(fixture.sourceSnapshotDir, 'index.html'), 'drift');
    const operator = await loadOperator();
    const campaignCalls = [];
    const calls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async (...args) => { campaignCalls.push(args); },
        spawnProcess: async (...args) => { calls.push(args); },
    }), /operator\.product/);
    assert.equal(campaignCalls.length, 0);
    assert.equal(calls.length, 0);
});

test('campaign verifier wrapper drift is rejected before campaign or external invocation', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    await fs.appendFile(path.join(fixture.sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs'), '\n// drift\n');
    const operator = await loadOperator();
    const campaignCalls = [];
    const calls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async (...args) => { campaignCalls.push(args); },
        spawnProcess: async (...args) => { calls.push(args); },
    }), /operator\.source/);
    assert.equal(campaignCalls.length, 0);
    assert.equal(calls.length, 0);
});

test('pre-existing operator output consumes the release id without external invocation', async (t) => {
    const fixture = await makeFixture(t);
    await fs.writeFile(fixture.config.deploymentRecordPath, 'foreign\n');
    const operator = await loadOperator();
    const calls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, { spawnProcess: async (...args) => { calls.push(args); } }), /RELEASE_ID_CONSUMED/);
    assert.equal(calls.length, 0);
    assert.equal(await fs.readFile(fixture.config.deploymentRecordPath, 'utf8'), 'foreign\n');
});

test('ambiguous post-deploy ownership is indeterminate and publishes no record', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    const operator = await loadOperator();
    const row = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: fixture.config.immutableUrl, Status: 'success', Build: 'success' };
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async () => {},
        spawnProcess: async () => {
            calls += 1;
            if (calls === 1 || calls === 3) return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([row])), stderr: Buffer.alloc(0) };
            return { exitCode: 0, signal: null, stdout: Buffer.from('upload-complete\n'), stderr: Buffer.alloc(0) };
        },
    }), /INDETERMINATE/);
    assert.equal(calls, 3);
    await assert.rejects(fs.access(fixture.config.deploymentRecordPath));
});

test('rollback accepts a sealed exact-five baseline and invokes once', async (t) => {
    const fixture = await makeFixture(t);
    const operator = await loadOperator();
    fixture.config.baselineRoot = path.join(fixture.operationalRoot, 'rollback-stage');
    const productFiles = {};
    for (const [publicPath, [name, mime]] of Object.entries(fixture.product)) {
        const source = path.join(fixture.sourceSnapshotDir, name);
        productFiles[publicPath] = { bytes: (await fs.stat(source)).size, mime, sha256: (await import('node:crypto')).createHash('sha256').update(await fs.readFile(source)).digest('hex') };
        await fs.mkdir(path.join(fixture.operationalRoot, 'baseline'), { recursive: true });
        await fs.copyFile(source, path.join(fixture.operationalRoot, 'baseline', name));
    }
    await fs.writeFile(fixture.config.rollbackBaselinePath, JSON.stringify({ schemaVersion: 1, projectName: 'penguin-exit-0', environment: 'Production', branch: 'main', deploymentId: '11111111-1111-4111-8111-111111111111', immutableUrl: fixture.config.immutableUrl, aliasUrl: fixture.config.aliasUrl, sourceGitHead: fixture.config.sourceGitHead, sourceGitTree: fixture.config.sourceGitTree, productFiles, capturedUtc: new Date().toISOString() }) + '\n');
    fixture.config.mode = 'rollback';
    const calls = [];
    const preRow = { Id: '33333333-3333-4333-8333-333333333333', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: 'https://33333333.penguin-exit-0.pages.dev/', Status: 'success', Build: 'success' };
    const postRow = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: fixture.config.immutableUrl, Status: 'success', Build: 'success' };
    const result = await operator.runOperator(fixture.config, { spawnProcess: async (argv, options) => { calls.push({ argv, options }); if (calls.length === 1) return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([preRow])), stderr: Buffer.alloc(0) }; if (calls.length === 2) return { exitCode: 0, signal: null, stdout: Buffer.from('rollback\n'), stderr: Buffer.alloc(0) }; return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([postRow])), stderr: Buffer.alloc(0) }; } });
    assert.equal(result.status, 'ROLLED_BACK');
    assert.equal(calls.length, 3);
    assert.equal(calls[1].options.shell, false);
    assert.equal(calls[1].argv[2], 'pages');
    assert.equal(calls[1].argv[3], 'deploy');
    assert.equal(await fs.stat(fixture.config.rollbackBaselinePath).then(() => true), true);
    const receipt = JSON.parse(await fs.readFile(fixture.config.deploymentReceiptPath, 'utf8'));
    assert.equal(receipt.operation, 'rollback');
    assert.equal(receipt.capture.stdoutBytes, Buffer.byteLength('rollback\n'));
    assert.equal(receipt.capture.stderrBytes, 0);
    assert.equal(receipt.preDeploymentId, preRow.Id);
    assert.equal(receipt.postDeploymentId, postRow.Id);
    assert.equal(calls[1].argv[calls[1].argv.indexOf('--commit-hash') + 1], fixture.config.sourceGitHead);
});

test('rollback refuses an already-active baseline before sending the rollback request', async (t) => {
    const fixture = await makeFixture(t);
    const operator = await loadOperator();
    fixture.config.mode = 'rollback';
    fixture.config.baselineRoot = path.join(fixture.operationalRoot, 'rollback-stage');
    await fs.mkdir(path.join(fixture.operationalRoot, 'baseline'), { recursive: true });
    const productFiles = {};
    for (const [publicPath, [name, mime]] of Object.entries(fixture.product)) {
        const bytes = await fs.readFile(path.join(fixture.sourceSnapshotDir, name));
        productFiles[publicPath] = { bytes: bytes.length, mime, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
        await fs.writeFile(path.join(fixture.operationalRoot, 'baseline', name), bytes);
    }
    const baselineRow = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: fixture.config.immutableUrl, Status: 'success', Build: 'success' };
    await fs.writeFile(fixture.config.rollbackBaselinePath, JSON.stringify({ schemaVersion: 1, projectName: 'penguin-exit-0', environment: 'Production', branch: 'main', deploymentId: baselineRow.Id, immutableUrl: baselineRow.Deployment, aliasUrl: fixture.config.aliasUrl, sourceGitHead: fixture.config.sourceGitHead, sourceGitTree: fixture.config.sourceGitTree, productFiles, capturedUtc: new Date().toISOString() }) + '\n');
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, { spawnProcess: async () => {
        calls += 1;
        return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([baselineRow])), stderr: Buffer.alloc(0) };
    } }), /rollback\.pre\.alreadyBaseline/);
    assert.equal(calls, 1);
    await assert.rejects(fs.access(fixture.config.deploymentReceiptPath));
});

test('rollback rejects a malformed baseline source identity before external invocation', async (t) => {
    const fixture = await makeFixture(t);
    const operator = await loadOperator();
    fixture.config.mode = 'rollback';
    fixture.config.baselineRoot = path.join(fixture.operationalRoot, 'rollback-stage');
    await fs.mkdir(path.join(fixture.operationalRoot, 'baseline'), { recursive: true });
    const productFiles = {};
    for (const [publicPath, [name, mime]] of Object.entries(fixture.product)) {
        const source = path.join(fixture.sourceSnapshotDir, name);
        const bytes = await fs.readFile(source);
        const digest = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
        productFiles[publicPath] = { bytes: bytes.length, mime, sha256: digest };
        await fs.copyFile(source, path.join(fixture.operationalRoot, 'baseline', name));
    }
    await fs.writeFile(fixture.config.rollbackBaselinePath, JSON.stringify({ schemaVersion: 1, projectName: 'penguin-exit-0', environment: 'Production', branch: 'main', deploymentId: '11111111-1111-4111-8111-111111111111', immutableUrl: fixture.config.immutableUrl, aliasUrl: fixture.config.aliasUrl, sourceGitHead: 'd'.repeat(39), sourceGitTree: fixture.config.sourceGitTree, productFiles, capturedUtc: new Date().toISOString() }) + '\n');
    const calls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, { spawnProcess: async (...args) => { calls.push(args); } }), /rollback\.baseline/);
    assert.equal(calls.length, 0);
});

test('rollback rejects a symlinked baseline source file before external invocation', async (t) => {
    const fixture = await makeFixture(t);
    const operator = await loadOperator();
    fixture.config.mode = 'rollback';
    fixture.config.baselineRoot = path.join(fixture.operationalRoot, 'rollback-stage');
    const baselineDir = path.join(fixture.operationalRoot, 'baseline');
    await fs.mkdir(baselineDir, { recursive: true });
    const productFiles = {};
    for (const [publicPath, [name, mime]] of Object.entries(fixture.product)) {
        const source = path.join(fixture.sourceSnapshotDir, name);
        const bytes = await fs.readFile(source);
        productFiles[publicPath] = { bytes: bytes.length, mime, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
        await fs.copyFile(source, path.join(baselineDir, name));
    }
    await fs.rm(path.join(baselineDir, 'index.html'));
    await fs.symlink(path.join(fixture.sourceSnapshotDir, 'index.html'), path.join(baselineDir, 'index.html'), 'file');
    await fs.writeFile(fixture.config.rollbackBaselinePath, JSON.stringify({ schemaVersion: 1, projectName: 'penguin-exit-0', environment: 'Production', branch: 'main', deploymentId: '11111111-1111-4111-8111-111111111111', immutableUrl: fixture.config.immutableUrl, aliasUrl: fixture.config.aliasUrl, sourceGitHead: fixture.config.sourceGitHead, sourceGitTree: fixture.config.sourceGitTree, productFiles, capturedUtc: new Date().toISOString() }) + '\n');
    const calls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, { spawnProcess: async (...args) => { calls.push(args); } }), /rollback\.baseline\.bytes/);
    assert.equal(calls.length, 0);
});

test('rollback external ambiguity is indeterminate and publishes no success receipt', async (t) => {
    const fixture = await makeFixture(t);
    const operator = await loadOperator();
    fixture.config.mode = 'rollback';
    fixture.config.baselineRoot = path.join(fixture.operationalRoot, 'rollback-stage');
    const productFiles = {};
    await fs.mkdir(path.join(fixture.operationalRoot, 'baseline'), { recursive: true });
    for (const [publicPath, [name, mime]] of Object.entries(fixture.product)) {
        const source = path.join(fixture.sourceSnapshotDir, name);
        const bytes = await fs.readFile(source);
        productFiles[publicPath] = { bytes: bytes.length, mime, sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') };
        await fs.copyFile(source, path.join(fixture.operationalRoot, 'baseline', name));
    }
    await fs.writeFile(fixture.config.rollbackBaselinePath, JSON.stringify({ schemaVersion: 1, projectName: 'penguin-exit-0', environment: 'Production', branch: 'main', deploymentId: '11111111-1111-4111-8111-111111111111', immutableUrl: fixture.config.immutableUrl, aliasUrl: fixture.config.aliasUrl, sourceGitHead: fixture.config.sourceGitHead, sourceGitTree: fixture.config.sourceGitTree, productFiles, capturedUtc: new Date().toISOString() }) + '\n');
    await assert.rejects(() => operator.runOperator(fixture.config, { spawnProcess: async () => { throw new Error('timeout'); } }), /INDETERMINATE/);
    await assert.rejects(fs.access(fixture.config.deploymentReceiptPath));
    assert.equal(await fs.readFile(fixture.config.rollbackBaselinePath, 'utf8').then((value) => value.includes('11111111-1111-4111-8111-111111111111')), true);
});

test('source snapshot rejects an unapproved executable script before any child process', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    await fs.mkdir(path.join(fixture.sourceSnapshotDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(fixture.sourceSnapshotDir, 'scripts', 'public-smoke-v2-lib.mjs'), 'export const drift = true;\n');
    const operator = await loadOperator();
    const calls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async () => {},
        spawnProcess: async (...args) => { calls.push(args); },
    }), /operator\.source\.manifest/);
    assert.equal(calls.length, 0);
});

test('failed ownership status or build is rejected before deployment', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    const operator = await loadOperator();
    const row = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: fixture.config.immutableUrl, Status: 'failed', Build: 'success' };
    const calls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async () => {},
        spawnProcess: async (...args) => { calls.push(args); return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([row])), stderr: Buffer.alloc(0) }; },
    }), /operator\.pre\.ownership/);
    assert.equal(calls.length, 1);
});

test('pre-external launch lock consumes the identity even when campaign validation fails', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    await fs.appendFile(path.join(fixture.sourceSnapshotDir, 'scripts', 'public-smoke-v2-lib.mjs'), '\n// drift\n');
    const operator = await loadOperator();
    await assert.rejects(() => operator.runOperator(fixture.config), /operator\.source\.manifest/);
    await assert.rejects(() => operator.runOperator(fixture.config), /RELEASE_ID_CONSUMED/);
});

test('post-deploy timeout or malformed ownership is indeterminate after the request', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    const operator = await loadOperator();
    const row = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: fixture.config.immutableUrl, Status: 'success', Build: 'success' };
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async () => {},
        spawnProcess: async () => {
            calls += 1;
            if (calls === 1) return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([row])), stderr: Buffer.alloc(0) };
            if (calls === 2) return { exitCode: 0, signal: null, stdout: Buffer.from('upload\n'), stderr: Buffer.alloc(0) };
            return { exitCode: null, signal: 'SIGTERM', timedOut: true, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
    }), /INDETERMINATE/);
    assert.equal(calls, 3);
    await assert.rejects(fs.access(fixture.config.deploymentRecordPath));
});

test('rollback requires a post-rollback ownership read before publishing success', async (t) => {
    const fixture = await makeFixture(t);
    const operator = await loadOperator();
    fixture.config.mode = 'rollback';
    fixture.config.baselineRoot = path.join(fixture.operationalRoot, 'rollback-stage');
    const productFiles = {};
    await fs.mkdir(path.join(fixture.operationalRoot, 'baseline'), { recursive: true });
    for (const [publicPath, [name, mime]] of Object.entries(fixture.product)) {
        const source = path.join(fixture.sourceSnapshotDir, name);
        const bytes = await fs.readFile(source);
        productFiles[publicPath] = { bytes: bytes.length, mime, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
        await fs.copyFile(source, path.join(fixture.operationalRoot, 'baseline', name));
    }
    await fs.writeFile(fixture.config.rollbackBaselinePath, JSON.stringify({ schemaVersion: 1, projectName: 'penguin-exit-0', environment: 'Production', branch: 'main', deploymentId: '11111111-1111-4111-8111-111111111111', immutableUrl: fixture.config.immutableUrl, aliasUrl: fixture.config.aliasUrl, sourceGitHead: fixture.config.sourceGitHead, sourceGitTree: fixture.config.sourceGitTree, productFiles, capturedUtc: new Date().toISOString() }) + '\n');
    const wrongPostRow = { Id: '22222222-2222-4222-8222-222222222222', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: 'https://22222222.penguin-exit-0.pages.dev/', Status: 'success', Build: 'success' };
    const preRow = { ...wrongPostRow, Id: '33333333-3333-4333-8333-333333333333', Deployment: 'https://33333333.penguin-exit-0.pages.dev/' };
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, {
        spawnProcess: async () => {
            calls += 1;
            if (calls === 1) return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([preRow])), stderr: Buffer.alloc(0) };
            if (calls === 2) return { exitCode: 0, signal: null, stdout: Buffer.from('rollback\n'), stderr: Buffer.alloc(0) };
            return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([wrongPostRow])), stderr: Buffer.alloc(0) };
        },
    }), /INDETERMINATE/);
    assert.equal(calls, 3);
    await assert.rejects(fs.access(fixture.config.deploymentReceiptPath));
});

test('shared identity authority consumes a release and campaign ID across operational roots', async (t) => {
    const first = await makeFixture(t);
    await completeValidCampaign(first);
    const second = await makeFixture(t);
    await completeValidCampaign(second);
    process.env.R14_TASK7_IDENTITY_AUTHORITY_ROOT = first.identityAuthorityRoot;
    const oldRow = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: first.config.sourceGitHead.slice(0, 7), Deployment: first.config.immutableUrl, Status: 'success', Build: 'success' };
    const newRow = { ...oldRow, Id: '22222222-2222-4222-8222-222222222222', Deployment: 'https://22222222.penguin-exit-0.pages.dev/' };
    const operator = await loadOperator();
    let firstCalls = 0;
    await operator.runOperator(first.config, {
        runCampaignVerifier: async () => {},
        spawnProcess: async () => {
            firstCalls += 1;
            if (firstCalls === 1) return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([oldRow])), stderr: Buffer.alloc(0) };
            if (firstCalls === 2) return { exitCode: 0, signal: null, stdout: Buffer.from('upload\n'), stderr: Buffer.alloc(0) };
            return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([newRow])), stderr: Buffer.alloc(0) };
        },
    });
    let secondCalls = 0;
    await assert.rejects(() => operator.runOperator(second.config, { spawnProcess: async () => { secondCalls += 1; } }), /RELEASE_ID_CONSUMED/);
    assert.equal(secondCalls, 0);
});

test('shared identity lock namespace rejects a junction that escapes the authority root', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    const foreign = path.join(fixture.root, 'foreign-identity-namespace');
    await fs.mkdir(foreign);
    await fs.symlink(foreign, path.join(fixture.identityAuthorityRoot, 'r14-task7-identities'), 'junction');
    const operator = await loadOperator();
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async () => {},
        spawnProcess: async () => { calls += 1; return { exitCode: 0, signal: null, stdout: Buffer.from('[]'), stderr: Buffer.alloc(0) }; },
    }), /operator\.identity\.(namespace|lock)/);
    assert.equal(calls, 0);
    assert.deepEqual(await fs.readdir(foreign), []);
});

test('wrapper completion is followed by a final source and campaign rehash before ownership', async (t) => {
    const fixture = await makeFixture(t);
    await completeValidCampaign(fixture);
    const operator = await loadOperator();
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async () => { await fs.appendFile(path.join(fixture.config.campaignDir, 'claims.json'), '\nlate mutation\n'); },
        spawnProcess: async () => { calls += 1; return { exitCode: 0, signal: null, stdout: Buffer.from('unused\n'), stderr: Buffer.alloc(0) }; },
    }), /operator\.campaign\.mutable/);
    assert.equal(calls, 0);
});

test('authority manifest drift after wrapper completion is rejected before ownership', async (t) => {
    const fixture = await makeFixture(t);
    await completeValidCampaign(fixture);
    const operator = await loadOperator();
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async () => { await fs.appendFile(path.join(fixture.identityAuthorityRoot, 'authority-manifest.json'), '\nlate mutation\n'); },
        spawnProcess: async () => { calls += 1; return { exitCode: 0, signal: null, stdout: Buffer.from('unused\n'), stderr: Buffer.alloc(0) }; },
    }), /operator\.identity\.manifest\.mutable/);
    assert.equal(calls, 0);
});

test('campaign spec must be contained in the authenticated campaign tree', async (t) => {
    const fixture = await makeFixture(t);
    await completeValidCampaign(fixture);
    fixture.config.campaignSpecPath = path.join(fixture.root, 'outside-spec.json');
    await fs.writeFile(fixture.config.campaignSpecPath, '# drift\n');
    const operator = await loadOperator();
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, { spawnProcess: async () => { calls += 1; } }), /operator\.inputs\.campaignSpec/);
    assert.equal(calls, 0);
});

test('staging bytes are rechecked immediately before the deploy request', async (t) => {
    const fixture = await makeFixture(t);
    await completeValidCampaign(fixture);
    const operator = await loadOperator();
    const oldRow = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: fixture.config.immutableUrl, Status: 'success', Build: 'success' };
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async () => {},
        spawnProcess: async () => {
            calls += 1;
            if (calls === 1) {
                await fs.appendFile(path.join(fixture.config.stagingDir, 'index.html'), 'late staging drift');
                return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([oldRow])), stderr: Buffer.alloc(0) };
            }
            return { exitCode: 0, signal: null, stdout: Buffer.from('unexpected\n'), stderr: Buffer.alloc(0) };
        },
    }), /operator\.staging\.beforeDeploy\.bytes/);
    assert.equal(calls, 1);
});

test('CLI config binding records exact authority bytes and rejects tampering', async (t) => {
    const fixture = await makeFixture(t);
    await completeValidCampaign(fixture);
    const configPath = path.join(fixture.identityAuthorityRoot, 'config.json');
    const configBytes = Buffer.from(`${JSON.stringify(fixture.config)}\n`, 'utf8');
    await fs.writeFile(configPath, configBytes, { flag: 'wx' });
    const operator = await loadOperator();
    const digest = crypto.createHash('sha256').update(configBytes).digest('hex');
    const objectDigest = crypto.createHash('sha256').update(Buffer.from(`${JSON.stringify(fixture.config)}\n`, 'utf8')).digest('hex');
    const oldRow = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: fixture.config.immutableUrl, Status: 'success', Build: 'success' };
    const newRow = { ...oldRow, Id: '22222222-2222-4222-8222-222222222222', Deployment: 'https://22222222.penguin-exit-0.pages.dev/' };
    let calls = 0;
    const result = await operator.runOperator(fixture.config, {
        configSource: { path: configPath, bytes: configBytes.length, sha256: digest, objectSha256: objectDigest },
        runCampaignVerifier: async () => {},
        spawnProcess: async () => { calls += 1; if (calls === 1) return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([oldRow])), stderr: Buffer.alloc(0) }; if (calls === 2) return { exitCode: 0, signal: null, stdout: Buffer.from('upload\n'), stderr: Buffer.alloc(0) }; return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([newRow])), stderr: Buffer.alloc(0) }; },
    });
    assert.equal(result.receipt.configBinding.sha256, digest);
    assert.equal(result.receipt.configBinding.bytes, configBytes.length);
});

test('rollback rejects false baseline byte metadata before external invocation', async (t) => {
    const fixture = await makeFixture(t);
    const operator = await loadOperator();
    fixture.config.mode = 'rollback';
    fixture.config.baselineRoot = path.join(fixture.operationalRoot, 'rollback-stage');
    const productFiles = {};
    await fs.mkdir(path.join(fixture.operationalRoot, 'baseline'), { recursive: true });
    for (const [publicPath, [name, mime]] of Object.entries(fixture.product)) {
        const bytes = await fs.readFile(path.join(fixture.sourceSnapshotDir, name));
        productFiles[publicPath] = { bytes: bytes.length + 1, mime, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
        await fs.copyFile(path.join(fixture.sourceSnapshotDir, name), path.join(fixture.operationalRoot, 'baseline', name));
    }
    await fs.writeFile(fixture.config.rollbackBaselinePath, JSON.stringify({ schemaVersion: 1, projectName: 'penguin-exit-0', environment: 'Production', branch: 'main', deploymentId: '11111111-1111-4111-8111-111111111111', immutableUrl: fixture.config.immutableUrl, aliasUrl: fixture.config.aliasUrl, sourceGitHead: fixture.config.sourceGitHead, sourceGitTree: fixture.config.sourceGitTree, productFiles, capturedUtc: new Date().toISOString() }) + '\n');
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, { spawnProcess: async () => { calls += 1; } }), /rollback\.baseline\.bytes/);
    assert.equal(calls, 0);
});

test('rollback baseline record or source tree drift after request is indeterminate', async (t) => {
    const fixture = await makeFixture(t);
    const operator = await loadOperator();
    fixture.config.mode = 'rollback';
    fixture.config.baselineRoot = path.join(fixture.operationalRoot, 'rollback-stage');
    const productFiles = {};
    await fs.mkdir(path.join(fixture.operationalRoot, 'baseline'), { recursive: true });
    for (const [publicPath, [name, mime]] of Object.entries(fixture.product)) {
        const bytes = await fs.readFile(path.join(fixture.sourceSnapshotDir, name));
        productFiles[publicPath] = { bytes: bytes.length, mime, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
        await fs.copyFile(path.join(fixture.sourceSnapshotDir, name), path.join(fixture.operationalRoot, 'baseline', name));
    }
    await fs.writeFile(fixture.config.rollbackBaselinePath, JSON.stringify({ schemaVersion: 1, projectName: 'penguin-exit-0', environment: 'Production', branch: 'main', deploymentId: '11111111-1111-4111-8111-111111111111', immutableUrl: fixture.config.immutableUrl, aliasUrl: fixture.config.aliasUrl, sourceGitHead: fixture.config.sourceGitHead, sourceGitTree: fixture.config.sourceGitTree, productFiles, capturedUtc: new Date().toISOString() }) + '\n');
    const preRow = { Id: '33333333-3333-4333-8333-333333333333', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: 'https://33333333.penguin-exit-0.pages.dev/', Status: 'success', Build: 'success' };
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, { spawnProcess: async () => { calls += 1; if (calls === 1) return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([preRow])), stderr: Buffer.alloc(0) }; if (calls === 2) { await fs.appendFile(fixture.config.rollbackBaselinePath, 'late mutation\n'); return { exitCode: 0, signal: null, stdout: Buffer.from('rollback\n'), stderr: Buffer.alloc(0) }; } return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([{ Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: fixture.config.immutableUrl, Status: 'success', Build: 'success' }])), stderr: Buffer.alloc(0) }; } }), /INDETERMINATE: rollback\.baseline\.mutable/);
    assert.equal(calls, 3);
});

test('final pre-external fence rejects source drift after pre ownership', async (t) => {
    const fixture = await makeFixture(t);
    await completeValidCampaign(fixture);
    const operator = await loadOperator();
    const oldRow = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: fixture.config.immutableUrl, Status: 'success', Build: 'success' };
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async () => {},
        spawnProcess: async () => {
            calls += 1;
            if (calls === 1) {
                await fs.appendFile(path.join(fixture.config.sourceSnapshotDir, 'scripts', 'public-smoke-v2-lib.mjs'), '\nlate pre-external drift\n');
                return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([oldRow])), stderr: Buffer.alloc(0) };
            }
            return { exitCode: 0, signal: null, stdout: Buffer.from('unexpected deploy\n'), stderr: Buffer.alloc(0) };
        },
    }), /operator\.preExternal|operator\.source\.mutable/);
    assert.equal(calls, 1);
    await assert.rejects(fs.access(fixture.config.deploymentRecordPath));
});

test('final pre-external fence rejects a replaced staging root', async (t) => {
    const fixture = await makeFixture(t);
    await completeValidCampaign(fixture);
    const operator = await loadOperator();
    const oldRow = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: fixture.config.immutableUrl, Status: 'success', Build: 'success' };
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async () => {},
        spawnProcess: async () => {
            calls += 1;
            if (calls === 1) {
                const moved = `${fixture.config.stagingDir}.moved`;
                await fs.rename(fixture.config.stagingDir, moved);
                await fs.mkdir(fixture.config.stagingDir);
                for (const name of ['content.js', 'game-core.js', 'index.html', 'script.js', 'style.css']) await fs.copyFile(path.join(moved, name), path.join(fixture.config.stagingDir, name));
                return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([oldRow])), stderr: Buffer.alloc(0) };
            }
            return { exitCode: 0, signal: null, stdout: Buffer.from('unexpected deploy\n'), stderr: Buffer.alloc(0) };
        },
    }), /operator\.preExternal|operator\.staging\.root\.mutable/);
    assert.equal(calls, 1);
    await assert.rejects(fs.access(fixture.config.deploymentRecordPath));
});

test('pre ownership requires a well-formed source prefix even when source binding is relaxed', async (t) => {
    const fixture = await makeFixture(t);
    await completeValidCampaign(fixture);
    const operator = await loadOperator();
    const malformed = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: '', Deployment: fixture.config.immutableUrl, Status: 'success', Build: 'success' };
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async () => {},
        spawnProcess: async () => { calls += 1; return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([malformed])), stderr: Buffer.alloc(0) }; },
    }), /operator\.pre\.ownership/);
    assert.equal(calls, 1);
});

test('rollback post fence rejects source snapshot drift after the rollback request', async (t) => {
    const fixture = await makeFixture(t);
    const operator = await loadOperator();
    fixture.config.mode = 'rollback';
    fixture.config.baselineRoot = path.join(fixture.operationalRoot, 'rollback-stage');
    const productFiles = {};
    await fs.mkdir(path.join(fixture.operationalRoot, 'baseline'), { recursive: true });
    for (const [publicPath, [name, mime]] of Object.entries(fixture.product)) {
        const source = path.join(fixture.sourceSnapshotDir, name);
        const bytes = await fs.readFile(source);
        productFiles[publicPath] = { bytes: bytes.length, mime, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
        await fs.copyFile(source, path.join(fixture.operationalRoot, 'baseline', name));
    }
    await fs.writeFile(fixture.config.rollbackBaselinePath, JSON.stringify({ schemaVersion: 1, projectName: 'penguin-exit-0', environment: 'Production', branch: 'main', deploymentId: '11111111-1111-4111-8111-111111111111', immutableUrl: fixture.config.immutableUrl, aliasUrl: fixture.config.aliasUrl, sourceGitHead: fixture.config.sourceGitHead, sourceGitTree: fixture.config.sourceGitTree, productFiles, capturedUtc: new Date().toISOString() }) + '\n');
    const postRow = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: fixture.config.immutableUrl, Status: 'success', Build: 'success' };
    const preRow = { ...postRow, Id: '33333333-3333-4333-8333-333333333333', Deployment: 'https://33333333.penguin-exit-0.pages.dev/' };
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, {
        spawnProcess: async () => {
            calls += 1;
            if (calls === 1) return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([preRow])), stderr: Buffer.alloc(0) };
            if (calls === 2) {
                await fs.appendFile(path.join(fixture.config.sourceSnapshotDir, 'index.html'), '\nlate rollback source drift\n');
                return { exitCode: 0, signal: null, stdout: Buffer.from('rollback\n'), stderr: Buffer.alloc(0) };
            }
            return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([postRow])), stderr: Buffer.alloc(0) };
        },
    }), /INDETERMINATE: rollback\.(source|post)/);
    assert.equal(calls, 3);
    await assert.rejects(fs.access(fixture.config.deploymentReceiptPath));
});

test('deploy post fence rejects Wrangler bytes changed during the post ownership child', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    const operator = await loadOperator();
    const oldRow = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: fixture.config.immutableUrl, Status: 'success', Build: 'success' };
    const newRow = { ...oldRow, Id: '22222222-2222-4222-8222-222222222222', Deployment: 'https://22222222.penguin-exit-0.pages.dev/' };
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, {
        runCampaignVerifier: async () => {},
        spawnProcess: async () => {
            calls += 1;
            if (calls === 1) return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([oldRow])), stderr: Buffer.alloc(0) };
            if (calls === 2) return { exitCode: 0, signal: null, stdout: Buffer.from('upload-complete\n'), stderr: Buffer.alloc(0) };
            await fs.writeFile(fixture.config.wranglerJsPath, '# foreign Wrangler bytes\n');
            return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([newRow])), stderr: Buffer.alloc(0) };
        },
    }), /INDETERMINATE: operator\.post\.mutable/);
    await assert.rejects(fs.access(fixture.config.deploymentReceiptPath));
});

test('rollback post fence rejects Wrangler bytes changed during the post ownership child', async (t) => {
    const fixture = await makeFixture(t);
    const operator = await loadOperator();
    fixture.config.mode = 'rollback';
    fixture.config.baselineRoot = path.join(fixture.operationalRoot, 'rollback-stage');
    await fs.mkdir(path.join(fixture.operationalRoot, 'baseline'), { recursive: true });
    const productFiles = {};
    for (const [publicPath, [name, mime]] of Object.entries(fixture.product)) {
        const bytes = await fs.readFile(path.join(fixture.sourceSnapshotDir, name));
        productFiles[publicPath] = { bytes: bytes.length, mime, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
        await fs.writeFile(path.join(fixture.operationalRoot, 'baseline', name), bytes);
    }
    await fs.writeFile(fixture.config.rollbackBaselinePath, JSON.stringify({ schemaVersion: 1, projectName: 'penguin-exit-0', environment: 'Production', branch: 'main', deploymentId: '11111111-1111-4111-8111-111111111111', immutableUrl: fixture.config.immutableUrl, aliasUrl: fixture.config.aliasUrl, sourceGitHead: fixture.config.sourceGitHead, sourceGitTree: fixture.config.sourceGitTree, productFiles, capturedUtc: new Date().toISOString() }) + '\n');
    const postRow = { Id: '11111111-1111-4111-8111-111111111111', Environment: 'Production', Branch: 'main', Source: fixture.config.sourceGitHead.slice(0, 7), Deployment: fixture.config.immutableUrl, Status: 'success', Build: 'success' };
    const preRow = { ...postRow, Id: '33333333-3333-4333-8333-333333333333', Deployment: 'https://33333333.penguin-exit-0.pages.dev/' };
    let calls = 0;
    await assert.rejects(() => operator.runOperator(fixture.config, { spawnProcess: async () => {
        calls += 1;
        if (calls === 1) return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([preRow])), stderr: Buffer.alloc(0) };
        if (calls === 2) return { exitCode: 0, signal: null, stdout: Buffer.from('rollback\n'), stderr: Buffer.alloc(0) };
        await fs.writeFile(fixture.config.wranglerJsPath, '# foreign Wrangler bytes\n');
        return { exitCode: 0, signal: null, stdout: Buffer.from(JSON.stringify([postRow])), stderr: Buffer.alloc(0) };
    } }), /INDETERMINATE: rollback\.(source|post)/);
    await assert.rejects(fs.access(fixture.config.deploymentReceiptPath));
});
