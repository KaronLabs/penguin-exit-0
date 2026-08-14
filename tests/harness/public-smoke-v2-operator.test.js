import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import crypto from 'node:crypto';

const OPERATOR_MODULE = '../../scripts/operator-deploy-public-smoke-v2.mjs';
const APPROVED_HEAD = 'c25015dbc5c0aee847e2abc1ca1f9fb389e5b34b';
const APPROVED_TREE = '5dcc38f22ee66a8a351ef610449a293c1e2aadd4';

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
    await fs.mkdir(path.join(sourceSnapshotDir, 'scripts'), { recursive: true });
    await fs.mkdir(operationalRoot, { recursive: true });
    await fs.mkdir(releaseRoot, { recursive: true });
    await fs.mkdir(campaignDir, { recursive: true });
    const product = {
        '/': ['index.html', 'text/html', '<!doctype html>\n'],
        '/content.js': ['content.js', 'application/javascript', 'content\n'],
        '/game-core.js': ['game-core.js', 'application/javascript', 'core\n'],
        '/script.js': ['script.js', 'application/javascript', 'script\n'],
        '/style.css': ['style.css', 'text/css', 'style\n'],
    };
    for (const [, [name]] of Object.entries(product)) await fs.copyFile(path.resolve(name), path.join(sourceSnapshotDir, name));
    const sourceFreezePath = path.join(sourceSnapshotDir, 'source-freeze.json');
    const wranglerJsPath = path.join(root, 'wrangler.js');
    await fs.writeFile(wranglerJsPath, '# fake pinned wrangler\n');
    const digest = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
    const nodeExeSha256 = await digest(process.execPath);
    const wranglerJsSha256 = await digest(wranglerJsPath);
    await fs.writeFile(sourceFreezePath, JSON.stringify({ schemaVersion: 1, sourceGitHead: APPROVED_HEAD, sourceGitTree: APPROVED_TREE, operatorSha256: await digest(path.resolve('scripts/operator-deploy-public-smoke-v2.mjs')), campaignVerifierSha256: await digest(path.resolve('scripts/verify-r14-campaign-v5.mjs')), nodeExeSha256, wranglerJsSha256 }) + '\n');
    const config = {
        schemaVersion: 1,
        mode: 'deploy',
        projectName: 'penguin-exit-0',
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
    return { root, sourceSnapshotDir, operationalRoot, releaseRoot, product, config };
}

async function completeCampaign(fixture) {
    await fs.writeFile(fixture.config.campaignSpecPath, '{}\n');
    await fs.writeFile(fixture.config.campaignReceiptPath, '{}\n');
    await fs.writeFile(path.join(fixture.config.campaignDir, 'claims.json'), '{}\n');
    await fs.writeFile(path.join(fixture.config.campaignDir, 'submission-envelope.json'), '{}\n');
    await fs.copyFile(path.resolve('scripts/verify-r14-campaign-v5.mjs'), path.join(fixture.config.sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs'));
}

test('operator exposes source-bound deploy and rollback entrypoints', async () => {
    const operator = await loadOperator();
    assert.equal(typeof operator.validateOperatorConfig, 'function');
    assert.equal(typeof operator.buildDeployArgv, 'function');
    assert.equal(typeof operator.buildRollbackArgv, 'function');
    assert.equal(typeof operator.buildCampaignVerifierArgv, 'function');
    assert.equal(typeof operator.runOperator, 'function');
});

test('default campaign-v5 child requires the exact verified gate line', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    const operator = await loadOperator();
    const calls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, {
        spawnProcess: async (argv, options) => {
            calls.push({ argv, options });
            return { exitCode: 0, signal: null, stdout: Buffer.from('R10_CAMPAIGN_GATE=NO_GO reason=spoof\n'), stderr: Buffer.alloc(0) };
        },
    }), /operator\.campaignVerifier/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].argv[1], path.join(fixture.config.sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs'));
    await assert.rejects(fs.access(fixture.config.deploymentRecordPath));
});

test('campaign gate failure consumes the release id and forbids same-id retry', async (t) => {
    const fixture = await makeFixture(t);
    await completeCampaign(fixture);
    const operator = await loadOperator();
    const firstCalls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, {
        spawnProcess: async (...args) => {
            firstCalls.push(args);
            return { exitCode: 1, signal: null, stdout: Buffer.from('R10_CAMPAIGN_GATE=NO_GO\n'), stderr: Buffer.from('reason\n') };
        },
    }), /operator\.campaignVerifier/);
    assert.equal(firstCalls.length, 1);
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
    await fs.writeFile(fixture.config.rollbackBaselinePath, JSON.stringify({ schemaVersion: 1, projectName: 'penguin-exit-0', environment: 'Production', branch: 'main', deploymentId: '11111111-1111-4111-8111-111111111111', immutableUrl: fixture.config.immutableUrl, aliasUrl: fixture.config.aliasUrl, sourceGitHead: fixture.config.sourceGitHead, productFiles, capturedUtc: new Date().toISOString() }) + '\n');
    fixture.config.mode = 'rollback';
    const calls = [];
    const result = await operator.runOperator(fixture.config, { spawnProcess: async (argv, options) => { calls.push({ argv, options }); return { exitCode: 0, signal: null, stdout: Buffer.from('rollback\n'), stderr: Buffer.alloc(0) }; } });
    assert.equal(result.status, 'ROLLED_BACK');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].argv[2], 'pages');
    assert.equal(calls[0].argv[3], 'deploy');
    assert.equal(await fs.stat(fixture.config.rollbackBaselinePath).then(() => true), true);
    const receipt = JSON.parse(await fs.readFile(fixture.config.deploymentReceiptPath, 'utf8'));
    assert.equal(receipt.operation, 'rollback');
    assert.equal(receipt.capture.stdoutBytes, Buffer.byteLength('rollback\n'));
    assert.equal(receipt.capture.stderrBytes, 0);
    assert.equal(calls[0].argv[calls[0].argv.indexOf('--commit-hash') + 1], fixture.config.sourceGitHead);
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
    await fs.writeFile(fixture.config.rollbackBaselinePath, JSON.stringify({ schemaVersion: 1, projectName: 'penguin-exit-0', environment: 'Production', branch: 'main', deploymentId: '11111111-1111-4111-8111-111111111111', immutableUrl: fixture.config.immutableUrl, aliasUrl: fixture.config.aliasUrl, sourceGitHead: 'd'.repeat(39), productFiles, capturedUtc: new Date().toISOString() }) + '\n');
    const calls = [];
    await assert.rejects(() => operator.runOperator(fixture.config, { spawnProcess: async (...args) => { calls.push(args); } }), /rollback\.baseline/);
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
    await fs.writeFile(fixture.config.rollbackBaselinePath, JSON.stringify({ schemaVersion: 1, projectName: 'penguin-exit-0', environment: 'Production', branch: 'main', deploymentId: '11111111-1111-4111-8111-111111111111', immutableUrl: fixture.config.immutableUrl, aliasUrl: fixture.config.aliasUrl, sourceGitHead: fixture.config.sourceGitHead, productFiles, capturedUtc: new Date().toISOString() }) + '\n');
    await assert.rejects(() => operator.runOperator(fixture.config, { spawnProcess: async () => { throw new Error('timeout'); } }), /INDETERMINATE/);
    await assert.rejects(fs.access(fixture.config.deploymentReceiptPath));
    assert.equal(await fs.readFile(fixture.config.rollbackBaselinePath, 'utf8').then((value) => value.includes('11111111-1111-4111-8111-111111111111')), true);
});
