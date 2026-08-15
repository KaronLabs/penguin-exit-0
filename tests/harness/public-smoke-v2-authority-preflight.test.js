import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const MODULE = '../../scripts/prepare-r14-task7-authority.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function identityAt(date) {
    const instant = new Date(date);
    instant.setMilliseconds(0);
    const stamp = instant.toISOString().replaceAll('-', '').replaceAll(':', '').replace('.000', '');
    return {
        releaseId: `${stamp}-r14-public-smoke-v2`,
        campaignRunId: `${stamp}-r10-korean-release`,
        issuedUtc: instant.toISOString(),
    };
}

async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'r14-task7-authority-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const authorityRoot = path.join(root, 'identity-authority');
    await fs.mkdir(authorityRoot);
    const files = {};
    for (const [name, bytes] of Object.entries({
        node: 'pinned-node\n',
        wrangler: 'pinned-wrangler\n',
        operator: 'approved-operator\n',
        campaignVerifier: 'approved-campaign-verifier\n',
    })) {
        const file = path.join(root, `${name}.mjs`);
        await fs.writeFile(file, bytes);
        files[name] = { path: file, sha256: sha256(Buffer.from(bytes)) };
    }
    const identity = identityAt(new Date());
    return {
        root,
        authorityRoot,
        config: {
            schemaVersion: 1,
            projectName: 'penguin-exit-0',
            accountId: '0123456789abcdef0123456789abcdef',
            sourceGitHead: '349573e9a4fc3006db71c823a0571dfe9ec26847',
            sourceGitTree: 'e87817dd9d5a9b84427f70b998336a76031b6e70',
            releaseId: identity.releaseId,
            campaignRunId: identity.campaignRunId,
            authorityRoot,
            nodeExePath: files.node.path,
            nodeExeSha256: files.node.sha256,
            wranglerJsPath: files.wrangler.path,
            wranglerJsSha256: files.wrangler.sha256,
            operatorPath: files.operator.path,
            operatorSha256: files.operator.sha256,
            campaignVerifierPath: files.campaignVerifier.path,
            campaignVerifierSha256: files.campaignVerifier.sha256,
            issuedUtc: identity.issuedUtc,
        },
    };
}

test('authority preparer exclusively creates a source-bound manifest and two issuance records', async (t) => {
    const { prepareAuthority } = await import(MODULE);
    const { authorityRoot, config } = await fixture(t);

    const result = await prepareAuthority(config);

    assert.equal(result.status, 'PREPARED');
    const manifestPath = path.join(authorityRoot, 'authority-manifest.json');
    const manifestBytes = await fs.readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    assert.deepEqual(Object.keys(manifest), [
        'schemaVersion', 'projectName', 'accountId', 'sourceGitHead', 'sourceGitTree',
        'nodeExeSha256', 'wranglerJsSha256', 'operatorSha256', 'campaignVerifierSha256', 'createdUtc',
    ]);
    assert.equal(manifest.sourceGitHead, config.sourceGitHead);
    assert.equal(manifest.sourceGitTree, config.sourceGitTree);
    assert.equal(manifest.createdUtc, config.issuedUtc);
    const manifestSha256 = sha256(manifestBytes);
    for (const [kind, id] of [['release', config.releaseId], ['campaign', config.campaignRunId]]) {
        const issuance = JSON.parse(await fs.readFile(path.join(authorityRoot, 'issuance', kind, `${id}.json`)));
        assert.deepEqual(Object.keys(issuance), [
            'schemaVersion', 'kind', 'id', 'projectName', 'accountId', 'sourceGitHead',
            'sourceGitTree', 'issuedUtc', 'authorityManifestSha256',
        ]);
        assert.equal(issuance.kind, kind);
        assert.equal(issuance.id, id);
        assert.equal(issuance.authorityManifestSha256, manifestSha256);
    }
});

test('authority preparer CLI accepts one absolute config and emits one exact success line', async (t) => {
    const { root, config } = await fixture(t);
    const configPath = path.join(root, 'authority-config.json');
    await fs.writeFile(configPath, `${JSON.stringify(config)}\n`);

    const child = spawnSync(process.execPath, [path.resolve('scripts/prepare-r14-task7-authority.mjs'), '--config', configPath], {
        cwd: process.cwd(),
        encoding: 'utf8',
        shell: false,
    });

    assert.equal(child.status, 0);
    assert.equal(child.signal, null);
    assert.equal(child.stdout, 'R14_TASK7_AUTHORITY=PREPARED\n');
    assert.equal(child.stderr, '');
});

test('authority preparer preserves one shared manifest while issuing the next fresh identities', async (t) => {
    const { prepareAuthority } = await import(MODULE);
    const { authorityRoot, config } = await fixture(t);
    await prepareAuthority(config);
    const manifestPath = path.join(authorityRoot, 'authority-manifest.json');
    const originalManifest = await fs.readFile(manifestPath);
    const next = { ...config, ...identityAt(new Date(Date.parse(config.issuedUtc) + 1000)) };

    const result = await prepareAuthority(next);

    assert.equal(result.status, 'PREPARED');
    assert.deepEqual(await fs.readFile(manifestPath), originalManifest);
    assert.equal((await fs.stat(manifestPath)).size, originalManifest.length);
    for (const [kind, id] of [['release', next.releaseId], ['campaign', next.campaignRunId]]) {
        const issuance = JSON.parse(await fs.readFile(path.join(authorityRoot, 'issuance', kind, `${id}.json`)));
        assert.equal(issuance.issuedUtc, next.issuedUtc);
        assert.equal(issuance.authorityManifestSha256, sha256(originalManifest));
    }
});

test('authority preparer rejects reused identities without changing existing authority bytes', async (t) => {
    const { prepareAuthority } = await import(MODULE);
    const { authorityRoot, config } = await fixture(t);
    await prepareAuthority(config);
    const paths = [
        path.join(authorityRoot, 'authority-manifest.json'),
        path.join(authorityRoot, 'issuance', 'release', `${config.releaseId}.json`),
        path.join(authorityRoot, 'issuance', 'campaign', `${config.campaignRunId}.json`),
    ];
    const before = await Promise.all(paths.map((file) => fs.readFile(file)));

    await assert.rejects(prepareAuthority(config), /RELEASE_ID_CONSUMED/);

    const after = await Promise.all(paths.map((file) => fs.readFile(file)));
    assert.deepEqual(after, before);
});

test('authority preparer rejects a pinned tool below a junction ancestor before writing authority', async (t) => {
    const { prepareAuthority } = await import(MODULE);
    const { root, authorityRoot, config } = await fixture(t);
    const actualTools = path.join(root, 'actual-tools');
    const linkedTools = path.join(root, 'linked-tools');
    await fs.mkdir(actualTools);
    const nodeBytes = await fs.readFile(config.nodeExePath);
    await fs.writeFile(path.join(actualTools, 'node.mjs'), nodeBytes);
    await fs.symlink(actualTools, linkedTools, 'junction');
    config.nodeExePath = path.join(linkedTools, 'node.mjs');

    await assert.rejects(prepareAuthority(config), /authority\.config\.node/);

    await assert.rejects(fs.stat(path.join(authorityRoot, 'authority-manifest.json')), { code: 'ENOENT' });
});

test('authority preparer rejects account path and tool-hash drift before writing authority', async (t) => {
    const { prepareAuthority } = await import(MODULE);
    for (const mutation of [
        (config) => { config.accountId = 'not-an-account'; },
        (config) => { config.authorityRoot = 'relative-authority'; },
        (config) => { config.wranglerJsSha256 = 'f'.repeat(64); },
    ]) {
        const current = await fixture(t);
        mutation(current.config);
        await assert.rejects(prepareAuthority(current.config), /authority\.config/);
        await assert.rejects(fs.stat(path.join(current.authorityRoot, 'authority-manifest.json')), { code: 'ENOENT' });
    }
});

test('authority preparer rejects a drifted shared manifest before issuing another identity', async (t) => {
    const { prepareAuthority } = await import(MODULE);
    const { authorityRoot, config } = await fixture(t);
    await prepareAuthority(config);
    const manifestPath = path.join(authorityRoot, 'authority-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath));
    manifest.sourceGitTree = '0'.repeat(40);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const next = { ...config, ...identityAt(new Date(Date.parse(config.issuedUtc) + 2000)) };

    await assert.rejects(prepareAuthority(next), /authority\.manifest\.binding/);

    await assert.rejects(fs.stat(path.join(authorityRoot, 'issuance', 'release', `${next.releaseId}.json`)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(authorityRoot, 'issuance', 'campaign', `${next.campaignRunId}.json`)), { code: 'ENOENT' });
});

test('concurrent same-identity preparation permits one authority result and consumes the other', async (t) => {
    const { prepareAuthority } = await import(MODULE);
    const { authorityRoot, config } = await fixture(t);

    const results = await Promise.allSettled([prepareAuthority(config), prepareAuthority(config)]);

    assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
    const rejected = results.find((entry) => entry.status === 'rejected');
    assert.match(rejected.reason.message, /RELEASE_ID_CONSUMED/);
    await fs.stat(path.join(authorityRoot, 'issuance', 'release', `${config.releaseId}.json`));
    await fs.stat(path.join(authorityRoot, 'issuance', 'campaign', `${config.campaignRunId}.json`));
});

test('authority preparer rejects a source identity the production operator does not approve', async (t) => {
    const { prepareAuthority } = await import(MODULE);
    const { authorityRoot, config } = await fixture(t);
    config.sourceGitHead = '0'.repeat(40);

    await assert.rejects(prepareAuthority(config), /authority\.config\.source/);

    await assert.rejects(fs.stat(path.join(authorityRoot, 'authority-manifest.json')), { code: 'ENOENT' });
});

test('authority preparer requires matching fresh release campaign and issued UTC timestamps', async (t) => {
    const { prepareAuthority } = await import(MODULE);
    const now = new Date('2026-08-15T00:40:00.000Z');
    const cases = [
        (config) => { config.campaignRunId = identityAt(new Date(now.getTime() + 1000)).campaignRunId; },
        (config) => { config.issuedUtc = new Date(now.getTime() - 1000).toISOString(); },
        (config) => { Object.assign(config, identityAt(new Date(now.getTime() - 301000))); },
        (config) => { Object.assign(config, identityAt(new Date(now.getTime() + 301000))); },
    ];
    for (const mutate of cases) {
        const current = await fixture(t);
        Object.assign(current.config, identityAt(now));
        mutate(current.config);
        await assert.rejects(prepareAuthority(current.config, { now: () => now }), /authority\.config\.(identity|freshness)/);
        await assert.rejects(fs.stat(path.join(current.authorityRoot, 'authority-manifest.json')), { code: 'ENOENT' });
    }
});

test('authority preparer CLI rejects a config below a junction ancestor before writing authority', async (t) => {
    const { root, authorityRoot, config } = await fixture(t);
    const actual = path.join(root, 'actual-config');
    const linked = path.join(root, 'linked-config');
    await fs.mkdir(actual);
    await fs.symlink(actual, linked, 'junction');
    const configPath = path.join(actual, 'config.json');
    await fs.writeFile(configPath, `${JSON.stringify(config)}\n`);

    const child = spawnSync(process.execPath, [path.resolve('scripts/prepare-r14-task7-authority.mjs'), '--config', path.join(linked, 'config.json')], {
        cwd: process.cwd(), encoding: 'utf8', shell: false,
    });

    assert.notEqual(child.status, 0);
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /authority\.config\.path/);
    await assert.rejects(fs.stat(path.join(authorityRoot, 'authority-manifest.json')), { code: 'ENOENT' });
});
