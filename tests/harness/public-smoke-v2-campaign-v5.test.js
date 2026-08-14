import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';

const RUN_ID = '20260815T120000Z-r10-korean-release';
const SOURCE_HEAD = 'c25015dbc5c0aee847e2abc1ca1f9fb389e5b34b';

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile = async (file) => hash(await fs.readFile(file));
const json = (value) => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
const writeJson = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, json(value)); };
const utc = (offset = 0) => new Date(Date.now() + offset).toISOString();

async function makeFixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'r14-campaign-v5-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const campaignDir = path.join(root, 'campaign');
    const sourceRoot = path.join(campaignDir, 'source-snapshot');
    const executionRoot = path.join(root, 'execution');
    const authorityProjectRoot = path.join(root, 'project');
    const authorityWorkspaceRoot = path.join(root, 'workspace');
    const specPath = path.join(authorityWorkspaceRoot, 'campaign-spec.md');
    const campaignReceiptPath = path.join(root, 'campaign-receipt.json');
    await fs.mkdir(path.join(sourceRoot, 'scripts'), { recursive: true });
    await fs.mkdir(executionRoot, { recursive: true });
    await fs.mkdir(authorityProjectRoot, { recursive: true });
    await fs.mkdir(authorityWorkspaceRoot, { recursive: true });
    const currentV5 = path.resolve('scripts/verify-r14-campaign-v5.mjs');
    const currentLib = path.resolve('scripts/public-smoke-v2-lib.mjs');
    const sourceFiles = {
        'index.html': '<!doctype html>\n',
        'content.js': 'export const content = true;\n',
        'game-core.js': 'export const core = true;\n',
        'script.js': 'export const script = true;\n',
        'style.css': 'body { display: block; }\n',
    };
    for (const [relative, value] of Object.entries(sourceFiles)) await fs.writeFile(path.join(sourceRoot, relative), value);
    await fs.copyFile(currentV5, path.join(sourceRoot, 'scripts', 'verify-r10-campaign.mjs'));
    await fs.copyFile(currentLib, path.join(sourceRoot, 'scripts', 'public-smoke-v2-lib.mjs'));
    await fs.writeFile(specPath, '# campaign v5 fixture\n');

    const sourcePaths = Object.keys(sourceFiles).concat(['scripts/public-smoke-v2-lib.mjs', 'scripts/verify-r10-campaign.mjs']).sort();
    const files = [];
    for (const relative of sourcePaths) {
        const file = path.join(sourceRoot, relative);
        const bytes = await fs.readFile(file);
        files.push({ path: relative, sizeBytes: bytes.length, sha256: hash(bytes) });
    }
    const inventory = {
        schemaVersion: 1,
        algorithm: 'SHA-256',
        pathEncoding: 'UTF-8 NUL-terminated ordered path records',
        fileCount: files.length,
        pathListSha256: hash(Buffer.from(files.map((entry) => `${entry.path}\0`).join(''), 'utf8')),
        contentRecordsSha256: hash(Buffer.from(files.map((entry) => `${entry.path}\0${entry.sizeBytes}\0${entry.sha256}\0`).join(''), 'utf8')),
        files,
    };
    await writeJson(path.join(campaignDir, 'candidate-inventory.json'), inventory);
    await writeJson(path.join(campaignDir, 'artifact-manifest.json'), []);
    await fs.writeFile(path.join(campaignDir, 'ledger.jsonl'), `${JSON.stringify({ schemaVersion: 5, runId: RUN_ID, state: 'VERIFIED' })}\n`);
    for (const name of ['r9-before.json', 'r9-after.json', 'r10-before.json', 'r10-after.json']) await writeJson(path.join(campaignDir, name), { frozen: name });
    await fs.writeFile(path.join(campaignDir, 'performance-summary.json'), '{"summary":true}\n');
    await fs.writeFile(path.join(campaignDir, 'frame-samples.json'), '[1]\n');
    await fs.mkdir(path.join(campaignDir, 'commands'), { recursive: true });
    await fs.writeFile(path.join(campaignDir, 'commands', 'unit.stdout.log'), 'ok\n');
    await fs.writeFile(path.join(campaignDir, 'commands', 'unit.stderr.log'), '');
    const frozen = { fileCount: 1, pathListSha256: hash(Buffer.from('frozen\0')), beforeDigest: hash(Buffer.from('r10-before')), afterDigest: hash(Buffer.from('r10-before')) };
    const r10Frozen = { ...frozen, pathListSha256: hash(Buffer.from('r10\0')), beforeDigest: hash(Buffer.from('r10')), afterDigest: hash(Buffer.from('r10')) };
    const productHash = await hashFile(path.join(sourceRoot, 'game-core.js'));
    const claims = {
        schemaVersion: 5,
        runId: RUN_ID,
        v1Sha256: hash(Buffer.from('v1')),
        candidateInventory: { fileCount: inventory.fileCount, pathListSha256: inventory.pathListSha256, contentRecordsSha256: inventory.contentRecordsSha256 },
        gameCoreSha256: productHash,
        sourceGit: { branch: 'main', headSha: SOURCE_HEAD },
        unit: { tests: 29, passed: 29, failed: 0, exitCode: 0 },
        browser: { chromium: { passed: 16, failed: 0 }, firefox: { passed: 16, failed: 0 }, webkit: { passed: 16, failed: 0 }, integrity: true, reportedFailures: 0, exitCode: 0 },
        performance: { startedUtc: utc(-600000), endedUtc: utc(-1000), measuredDurationMs: 599000, environment: { nodeVersion: 'v22.21.1', platform: 'win32', arch: 'x64', project: 'chromium-perf' }, sampleCount: 100, rawMinMs: 1, rawMaxMs: 20, p50LatencyMs: 10, p95LatencyMs: 18, p99LatencyMs: 20, longTaskObserverSupported: true, longTasksCount: 0, heapStartMb: 1, heapEndMb: 2, heapNetGrowthMb: 1, totalActionsCount: 100 },
        negativeControls: { passed: 12, total: 12, failed: 0, exitCode: 0 },
        campaignVerifier: { tests: 1, passed: 1, failed: 0, exitCode: 0 },
        r9Frozen: frozen,
        r10Frozen,
        actualBrowserZoom: { claimed: false, equivalentReflow: 'fixture only', limitation: 'actual browser chrome zoom not claimed' },
    };
    await writeJson(path.join(campaignDir, 'claims.json'), claims);
    const payloadNames = ['artifact-manifest.json', 'candidate-inventory.json', 'claims.json', 'ledger.jsonl', 'r9-before.json', 'r9-after.json', 'r10-before.json', 'r10-after.json'];
    const envelope = {
        schemaVersion: 5,
        runId: RUN_ID,
        payloadHashes: Object.fromEntries(await Promise.all(payloadNames.map(async (name) => [name, await hashFile(path.join(campaignDir, name))]))),
        source: { path: 'source-snapshot', fileCount: inventory.fileCount, pathListSha256: inventory.pathListSha256, contentRecordsSha256: inventory.contentRecordsSha256, gitBranch: 'main', gitHeadSha: SOURCE_HEAD },
        spec: { fileName: path.basename(specPath), sizeBytes: (await fs.stat(specPath)).size, sha256: await hashFile(specPath) },
        rawEvidence: { summary: { path: 'performance-summary.json', sha256: await hashFile(path.join(campaignDir, 'performance-summary.json')) }, samples: { path: 'frame-samples.json', sha256: await hashFile(path.join(campaignDir, 'frame-samples.json')) } },
    };
    await writeJson(path.join(campaignDir, 'submission-envelope.json'), envelope);
    const command = { key: 'unit', argv: [process.execPath, '--test'], cwd: executionRoot, startedUtc: utc(-10000), endedUtc: utc(-9000), timeoutMs: 120000, timedOut: false, exitCode: 0, signal: null, stdoutPath: 'commands/unit.stdout.log', stdoutSha256: await hashFile(path.join(campaignDir, 'commands/unit.stdout.log')), stderrPath: 'commands/unit.stderr.log', stderrSha256: await hashFile(path.join(campaignDir, 'commands/unit.stderr.log')) };
    const receipt = {
        schemaVersion: 1,
        runId: RUN_ID,
        status: 'VERIFIED',
        createdUtc: utc(-700000),
        completedUtc: utc(-500),
        projectRoot: authorityProjectRoot,
        cleanRoot: executionRoot,
        campaign: { path: campaignDir, artifactManifestSha256: await hashFile(path.join(campaignDir, 'artifact-manifest.json')), submissionEnvelopeSha256: await hashFile(path.join(campaignDir, 'submission-envelope.json')) },
        spec: { path: specPath, sizeBytes: (await fs.stat(specPath)).size, sha256: await hashFile(specPath) },
        candidateInventory: claims.candidateInventory,
        gameCoreSha256: claims.gameCoreSha256,
        sourceGit: claims.sourceGit,
        r9Frozen: claims.r9Frozen,
        r10Frozen: claims.r10Frozen,
        commands: [command],
        limitation: claims.actualBrowserZoom,
        publicationState: 'COMMITTED only when operation SUCCESS.json exists',
    };
    await writeJson(campaignReceiptPath, receipt);
    await writeJson(path.join(campaignDir, 'campaign-receipt.json'), receipt);
    return { campaignDir, sourceRoot, executionRoot, authorityProjectRoot, authorityWorkspaceRoot, specPath, campaignReceiptPath, claims, envelope, receipt };
}

test('campaign-v5 verifier validates the complete source-bound fixture and rejects run drift', async (t) => {
    const fixture = await makeFixture(t);
    const verifier = await import('../../scripts/verify-r14-campaign-v5.mjs');
    assert.equal(typeof verifier.verifyCampaignV5, 'function');
    const result = verifier.verifyCampaignV5({ campaignDir: fixture.campaignDir, specPath: fixture.specPath, sourceRoot: fixture.sourceRoot, expectedRunId: RUN_ID, authorityProjectRoot: fixture.authorityProjectRoot, executionRoot: fixture.executionRoot });
    assert.equal(result.status, 'VERIFIED');
    assert.equal(result.runId, RUN_ID);
    assert.equal(result.sourceGitHead, SOURCE_HEAD);
    assert.equal(result.candidateFileCount, fixture.envelope.source.fileCount);
    const child = spawnSync(process.execPath, [
        path.join(fixture.sourceRoot, 'scripts', 'verify-r10-campaign.mjs'),
        '--campaign', fixture.campaignDir,
        '--spec', fixture.specPath,
        '--source', fixture.sourceRoot,
        '--execution-source', fixture.executionRoot,
        '--run', RUN_ID,
        '--authority-project', fixture.authorityProjectRoot,
        '--authority-workspace', fixture.authorityWorkspaceRoot,
    ], { cwd: fixture.authorityProjectRoot, encoding: 'utf8', windowsHide: true, shell: false });
    assert.equal(child.status, 0);
    assert.equal(child.stdout, 'R10_CAMPAIGN_GATE=VERIFIED\n');
    assert.equal(child.stderr, '');
    const candidatePath = path.join(fixture.campaignDir, 'candidate-inventory.json');
    const candidate = JSON.parse(await fs.readFile(candidatePath, 'utf8'));
    candidate.pathListSha256 = '0'.repeat(64);
    await writeJson(candidatePath, candidate);
    const claims = JSON.parse(await fs.readFile(path.join(fixture.campaignDir, 'claims.json'), 'utf8'));
    claims.candidateInventory.pathListSha256 = candidate.pathListSha256;
    await writeJson(path.join(fixture.campaignDir, 'claims.json'), claims);
    const envelope = JSON.parse(await fs.readFile(path.join(fixture.campaignDir, 'submission-envelope.json'), 'utf8'));
    envelope.payloadHashes['candidate-inventory.json'] = await hashFile(candidatePath);
    envelope.payloadHashes['claims.json'] = await hashFile(path.join(fixture.campaignDir, 'claims.json'));
    envelope.source.pathListSha256 = candidate.pathListSha256;
    await writeJson(path.join(fixture.campaignDir, 'submission-envelope.json'), envelope);
    const receipt = JSON.parse(await fs.readFile(fixture.campaignReceiptPath, 'utf8'));
    receipt.candidateInventory.pathListSha256 = candidate.pathListSha256;
    await writeJson(fixture.campaignReceiptPath, receipt);
    await writeJson(path.join(fixture.campaignDir, 'campaign-receipt.json'), receipt);
    assert.throws(() => verifier.verifyCampaignV5({ campaignDir: fixture.campaignDir, specPath: fixture.specPath, sourceRoot: fixture.sourceRoot, expectedRunId: RUN_ID, authorityProjectRoot: fixture.authorityProjectRoot, executionRoot: fixture.executionRoot }), /campaignV5\.candidate\.digest/);
    assert.throws(() => verifier.verifyCampaignV5({ campaignDir: fixture.campaignDir, specPath: fixture.specPath, sourceRoot: fixture.sourceRoot, expectedRunId: '20260815T120001Z-r10-korean-release', authorityProjectRoot: fixture.authorityProjectRoot, executionRoot: fixture.executionRoot }), /campaignV5.runId/);
});
