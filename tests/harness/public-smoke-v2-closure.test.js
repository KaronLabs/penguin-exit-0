import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as smoke from '../../scripts/public-smoke-v2-lib.mjs';

const BODY_TOKENS = ['root', 'content-js', 'game-core-js', 'script-js', 'style-css'];
const PUBLIC_PATHS = ['/', '/content.js', '/game-core.js', '/script.js', '/style.css'];

function sha(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function resealAcceptedManifest(acceptedDir, releaseId) {
    const files = [];
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(absolute);
            else if (entry.isFile() && path.relative(acceptedDir, absolute).split(path.sep).join('/') !== 'artifact-manifest.json') {
                const bytes = fs.readFileSync(absolute);
                files.push({ path: path.relative(acceptedDir, absolute).split(path.sep).join('/'), bytes: bytes.length, sha256: sha(bytes) });
            }
        }
    }
    walk(acceptedDir);
    files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    const manifest = { schemaVersion: 1, releaseId, files };
    manifest.manifestPayloadSha256 = sha(smoke.canonicalJson(manifest));
    writeJson(path.join(acceptedDir, 'artifact-manifest.json'), manifest);
    return manifest;
}

async function loadCompleteFixtureFactory() {
    const contractTestUrl = new URL('./public-smoke-v2-contract.test.js', import.meta.url);
    const smokeLibraryUrl = new URL('../../scripts/public-smoke-v2-lib.mjs', import.meta.url).href;
    const source = fs.readFileSync(contractTestUrl, 'utf8')
        .replace("import test from 'node:test';", 'const test = () => {};')
        .replaceAll("'../../scripts/public-smoke-v2-lib.mjs'", JSON.stringify(smokeLibraryUrl));
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(`${source}\nexport { createAcceptedFixture };\n`).toString('base64')}`;
    return (await import(moduleUrl)).createAcceptedFixture;
}

const fixtureFactoryPromise = loadCompleteFixtureFactory();

function buildNegativeReceipt(fixture, audit) {
    const auditorPath = path.join(fixture.project, 'scripts', 'verify-public-smoke-v2.mjs');
    fs.mkdirSync(path.dirname(auditorPath), { recursive: true });
    fs.writeFileSync(auditorPath, 'fixture auditor\n');
    const controls = smoke.NEGATIVE_CONTROL_REGISTRY.map(({ id, expectedInvariant }, index) => {
        const mutationRootRealpath = path.join(fixture.releaseRoot, 'negative-roots', `${index + 1}-${id.toLowerCase()}`);
        const targetRealpath = path.join(mutationRootRealpath, 'accepted');
        fs.mkdirSync(targetRealpath, { recursive: true });
        const derivedConfigPath = path.join(mutationRootRealpath, 'audit-config.json');
        const derived = {
            schemaVersion: 3,
            baseConfigPath: fixture.configPath,
            baseConfigSha256: smoke.sha256File(fixture.configPath),
            mutationId: id,
            mutationRootRealpath: fs.realpathSync(mutationRootRealpath),
            auditTargetRealpath: fs.realpathSync(targetRealpath),
            externalOperationReceiptPath: fixture.operationReceiptPath,
            auditReceiptPath: path.join(mutationRootRealpath, 'audit-receipt.json'),
        };
        writeJson(derivedConfigPath, derived);
        const stdout = Buffer.alloc(0);
        const stderr = Buffer.from(`AUDIT_TARGET_REALPATH=${derived.auditTargetRealpath}\n${expectedInvariant}\n`);
        fs.writeFileSync(path.join(mutationRootRealpath, 'auditor.stdout.bin'), stdout);
        fs.writeFileSync(path.join(mutationRootRealpath, 'auditor.stderr.bin'), stderr);
        return {
            id,
            expectedInvariant,
            derivedConfigSha256: smoke.sha256File(derivedConfigPath),
            mutationRootRealpath: derived.mutationRootRealpath,
            targetRealpath: derived.auditTargetRealpath,
            auditorArgv: [fixture.config.nodeExePath, auditorPath, '--config', derivedConfigPath],
            exitCode: index + 1,
            signal: null,
            stdoutSha256: sha(stdout),
            stderrSha256: sha(stderr),
            emittedTargetRealpath: derived.auditTargetRealpath,
            successGateAbsent: true,
            observedInvariant: expectedInvariant,
        };
    });
    const checkpoints = [{ controlId: 'BASELINE', phase: 'BASELINE' }];
    for (const { id } of smoke.NEGATIVE_CONTROL_REGISTRY) checkpoints.push({ controlId: id, phase: 'BEFORE' }, { controlId: id, phase: 'AFTER' });
    const rows = checkpoints.map((checkpoint, index) => ({
        sequence: index + 1,
        ...checkpoint,
        treeDigest: fixture.operationReceipt.accepted.treeDigest,
        auditReceiptSha256: '0'.repeat(64),
        auditStatus: 'VERIFIED',
    }));
    const checkpointAuditPaths = rows.map((checkpoint, index) => {
        const auditReceipt = structuredClone(audit);
        auditReceipt.createdUtc = new Date(Date.parse('2026-08-14T00:02:00.000Z') + index).toISOString();
        const file = path.join(
            path.dirname(fixture.config.negativeReceiptPath),
            'negative-checkpoint-audits',
            `${String(checkpoint.sequence).padStart(3, '0')}-${checkpoint.controlId.toLowerCase()}-${checkpoint.phase.toLowerCase()}.json`,
        );
        writeJson(file, auditReceipt);
        checkpoint.auditReceiptSha256 = smoke.sha256File(file);
        return file;
    });
    const receipt = {
        schemaVersion: 1,
        releaseId: fixture.config.releaseId,
        status: 'VERIFIED',
        createdUtc: '2026-08-14T00:03:00.000Z',
        configSha256: smoke.sha256File(fixture.configPath),
        operationReceiptSha256: smoke.sha256File(fixture.operationReceiptPath),
        pristineManifestSha256: fixture.operationReceipt.accepted.manifestSha256,
        pristineTreeDigest: fixture.operationReceipt.accepted.treeDigest,
        initialPristineAuditReceiptSha256: rows[0].auditReceiptSha256,
        finalPristineAuditReceiptSha256: rows.at(-1).auditReceiptSha256,
        checkpoints: rows,
        controls,
    };
    return { receipt, checkpointAuditPaths };
}

async function makeClosureFixture(t) {
    const createAcceptedFixture = await fixtureFactoryPromise;
    const fixture = createAcceptedFixture(t);
    const audit = smoke.auditAcceptedRun({ configPath: fixture.configPath });
    writeJson(fixture.config.auditReceiptPath, audit);
    const { receipt: negative, checkpointAuditPaths } = buildNegativeReceipt(fixture, audit);
    writeJson(fixture.config.negativeReceiptPath, negative);
    return { ...fixture, audit, negative, checkpointAuditPaths };
}

function ownershipRows(fixture) {
    return [{
        Id: fixture.operationReceipt.cloudflareReads.pre.deploymentId,
        Environment: 'Production',
        Branch: 'main',
        Source: fixture.acceptedRun.sourceGitHead.slice(0, 7),
        Deployment: fixture.config.immutableUrl,
        Status: 'Success',
        Build: 'fixture',
    }];
}

function localOnlyOverrides(fixture, mutations = {}) {
    const ownershipCalls = [];
    const getCalls = [];
    let tick = 0;
    const spawnSyncImpl = (file, argv, options) => {
        ownershipCalls.push({ file, argv, options });
        const value = { status: 0, signal: null, stdout: Buffer.from(`${JSON.stringify(ownershipRows(fixture))}\n`), stderr: Buffer.alloc(0) };
        return mutations.spawn ? mutations.spawn(value, fixture) : value;
    };
    const fetchImpl = async (url, options) => {
        getCalls.push({ url, options });
        const publicPath = new URL(url).pathname;
        const sourceName = publicPath === '/' ? 'index.html' : publicPath.slice(1);
        const body = fs.readFileSync(path.join(fixture.sourceSnapshot, sourceName));
        const mime = fixture.productFiles[publicPath].mime;
        const value = {
            status: 200,
            url,
            headers: { get: (name) => name.toLowerCase() === 'content-type' ? `${mime.toUpperCase()}; charset=UTF-8` : null },
            arrayBuffer: async () => body,
        };
        return mutations.fetch ? mutations.fetch(value, { publicPath, index: getCalls.length - 1, options }) : value;
    };
    return {
        ownershipCalls,
        getCalls,
        overrides: {
            spawnSyncImpl,
            fetchImpl,
            now: () => new Date(Date.parse('2026-08-14T00:04:00.000Z') + tick++),
            randomHex: () => 'a'.repeat(32),
            ...mutations.overrides,
        },
    };
}

function validClosureReceipt(fixture) {
    const bodyPaths = BODY_TOKENS.map((token) => `file-probes/bodies/closure-alias-${token}.bin`);
    return {
        schemaVersion: 1,
        releaseId: fixture.config.releaseId,
        createdUtc: '2026-08-14T00:04:00.100Z',
        configSha256: smoke.sha256File(fixture.configPath),
        operationReceiptSha256: smoke.sha256File(fixture.operationReceiptPath),
        auditReceiptSha256: smoke.sha256File(fixture.config.auditReceiptPath),
        negativeReceiptSha256: smoke.sha256File(fixture.config.negativeReceiptPath),
        acceptedManifestSha256: fixture.operationReceipt.accepted.manifestSha256,
        ownershipRead: {
            argv: [fixture.config.nodeExePath, fixture.config.wranglerJsPath, 'pages', 'deployment', 'list', '--project-name', fixture.config.projectName, '--environment', 'production', '--json'],
            cwd: fixture.project,
            startedUtc: '2026-08-14T00:04:00.000Z',
            finishedUtc: '2026-08-14T00:04:00.001Z',
            exitCode: 0,
            signal: null,
            stdoutPath: 'ownership/stdout.bin',
            stdoutBytes: 3,
            stdoutSha256: '1'.repeat(64),
            stderrPath: 'ownership/stderr.bin',
            stderrBytes: 0,
            stderrSha256: sha(Buffer.alloc(0)),
            deploymentId: fixture.operationReceipt.cloudflareReads.pre.deploymentId,
            sourcePrefix: fixture.acceptedRun.sourceGitHead.slice(0, 7),
            immutableUrl: fixture.config.immutableUrl,
        },
        finalAliasProbe: {
            receiptPath: 'file-probes/closure-final-alias-5.json',
            receiptSha256: '2'.repeat(64),
            bodyPaths,
            bodySha256s: BODY_TOKENS.map((_, index) => String(index + 3).repeat(64)),
            passed: 5,
            total: 5,
        },
        status: 'VERIFIED',
    };
}

function objectPaths(root, pathParts = []) {
    const rows = [];
    if (!root || typeof root !== 'object' || Array.isArray(root)) return rows;
    for (const [key, value] of Object.entries(root)) {
        rows.push([...pathParts, key]);
        rows.push(...objectPaths(value, [...pathParts, key]));
    }
    return rows;
}

function getAt(root, parts) {
    return parts.reduce((value, key) => value[key], root);
}

function setAt(root, parts, value) {
    let cursor = root;
    for (const key of parts.slice(0, -1)) cursor = cursor[key];
    cursor[parts.at(-1)] = value;
}

function wrongType(value) {
    if (typeof value === 'string') return 7;
    if (typeof value === 'number') return '7';
    if (typeof value === 'boolean') return 'true';
    if (value === null) return 0;
    return Array.isArray(value) ? {} : [];
}

test('closure exposes the schema validator and one-shot executable interface', async () => {
    assert.equal(typeof smoke.validateClosureReceipt, 'function', 'missing validateClosureReceipt production interface');
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    assert.equal(typeof closure.runClosureFromArgv, 'function', 'missing runClosureFromArgv production interface');
    assert.equal(typeof closure.runClosureFromConfig, 'function', 'missing runClosureFromConfig production interface');
});

test('closure receipt rejects every missing, unknown, and wrongly typed top or nested field', async (t) => {
    const fixture = await makeClosureFixture(t);
    const valid = validClosureReceipt(fixture);
    assert.deepEqual(smoke.validateClosureReceipt(structuredClone(valid)), valid);
    for (const parts of objectPaths(valid)) {
        const missing = structuredClone(valid);
        const parent = parts.slice(0, -1).reduce((value, key) => value[key], missing);
        delete parent[parts.at(-1)];
        assert.throws(() => smoke.validateClosureReceipt(missing), undefined, `missing ${parts.join('.')}`);
        const wrong = structuredClone(valid);
        setAt(wrong, parts, wrongType(getAt(wrong, parts)));
        assert.throws(() => smoke.validateClosureReceipt(wrong), undefined, `wrong type ${parts.join('.')}`);
    }
    const unknown = structuredClone(valid);
    unknown.unknown = true;
    assert.throws(() => smoke.validateClosureReceipt(unknown), /closureReceipt/);
});

test('offline receipt and accepted-evidence drift fails before ownership or alias reads', async (t) => {
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    for (const [name, mutate, invariant] of [
        ['operation status', (fixture) => { fixture.operationReceipt.status = 'PARTIAL'; writeJson(fixture.operationReceiptPath, fixture.operationReceipt); }, /operationReceipt.status/],
        ['audit count', (fixture) => { fixture.audit.passedCases = 5; writeJson(fixture.config.auditReceiptPath, fixture.audit); }, /auditReceipt.summary/],
        ['negative exit', (fixture) => { fixture.negative.controls[0].exitCode = 0; writeJson(fixture.config.negativeReceiptPath, fixture.negative); }, /negativeReceipt.control.exitCode/],
        ['manifest binding', (fixture) => { fixture.negative.pristineManifestSha256 = 'f'.repeat(64); writeJson(fixture.config.negativeReceiptPath, fixture.negative); }, /negativeReceipt.pristineManifestSha256/],
    ]) {
        await t.test(name, async (t) => {
            const fixture = await makeClosureFixture(t);
            mutate(fixture);
            const local = localOnlyOverrides(fixture);
            await assert.rejects(closure.runClosureFromConfig(fixture.configPath, local.overrides), invariant);
            assert.equal(local.ownershipCalls.length, 0);
            assert.equal(local.getCalls.length, 0);
            assert.equal(fs.existsSync(fixture.config.closureReceiptPath), false);
        });
    }
});

test('closure authenticates all 25 materialized checkpoint audit receipts before external reads', async (t) => {
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    const cases = [
        ['missing object', (fixture) => fs.unlinkSync(fixture.checkpointAuditPaths[7]), /negativeReceipt\.checkpointAuditReceipt\.file/],
        ['tampered bytes', (fixture) => fs.appendFileSync(fixture.checkpointAuditPaths[8], ' '), /negativeReceipt\.checkpointAuditReceipt\.sha256/],
        ['replayed bytes', (fixture) => fs.copyFileSync(fixture.checkpointAuditPaths[0], fixture.checkpointAuditPaths[9]), /negativeReceipt\.checkpointAuditReceipt\.sha256/],
        ['foreign valid object with rethreaded hash', (fixture) => {
            const index = 10;
            const foreign = JSON.parse(fs.readFileSync(fixture.checkpointAuditPaths[index], 'utf8'));
            foreign.releaseId = '20260815T000000Z-r14-public-smoke-v2';
            writeJson(fixture.checkpointAuditPaths[index], foreign);
            fixture.negative.checkpoints[index].auditReceiptSha256 = smoke.sha256File(fixture.checkpointAuditPaths[index]);
            writeJson(fixture.config.negativeReceiptPath, fixture.negative);
        }, /auditReceipt\.binding/],
        ['duplicate object and hash', (fixture) => {
            fs.copyFileSync(fixture.checkpointAuditPaths[0], fixture.checkpointAuditPaths[1]);
            fixture.negative.checkpoints[1].auditReceiptSha256 = fixture.negative.checkpoints[0].auditReceiptSha256;
            writeJson(fixture.config.negativeReceiptPath, fixture.negative);
        }, /negativeReceipt\.checkpoints\.unique/],
    ];
    for (const [name, mutate, invariant] of cases) {
        await t.test(name, async (t) => {
            const fixture = await makeClosureFixture(t);
            mutate(fixture);
            const local = localOnlyOverrides(fixture);
            await assert.rejects(closure.runClosureFromConfig(fixture.configPath, local.overrides), invariant);
            assert.equal(local.ownershipCalls.length, 0);
            assert.equal(local.getCalls.length, 0);
            assert.equal(fs.existsSync(fixture.config.closureReceiptPath), false);
        });
    }
});

test('a nested semantic attack still fails after every attacker-controlled downstream hash is resealed', async (t) => {
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    const fixture = await makeClosureFixture(t);
    const observationsPath = path.join(fixture.acceptedDir, 'observations.json');
    const observations = JSON.parse(fs.readFileSync(observationsPath, 'utf8'));
    observations[0].intrusions[1].type = 'copilot';
    writeJson(observationsPath, observations);
    const manifest = resealAcceptedManifest(fixture.acceptedDir, fixture.config.releaseId);
    const manifestSha256 = smoke.sha256File(path.join(fixture.acceptedDir, 'artifact-manifest.json'));
    fixture.operationReceipt.accepted.manifestSha256 = manifestSha256;
    fixture.operationReceipt.accepted.treeDigest = sha(smoke.canonicalJson({ files: manifest.files, manifestSha256 }));
    writeJson(fixture.operationReceiptPath, fixture.operationReceipt);
    fixture.audit.operationReceiptSha256 = smoke.sha256File(fixture.operationReceiptPath);
    fixture.audit.acceptedManifestSha256 = manifestSha256;
    writeJson(fixture.config.auditReceiptPath, fixture.audit);
    fixture.negative.operationReceiptSha256 = smoke.sha256File(fixture.operationReceiptPath);
    fixture.negative.pristineManifestSha256 = manifestSha256;
    fixture.negative.pristineTreeDigest = fixture.operationReceipt.accepted.treeDigest;
    fixture.negative.checkpoints.forEach((checkpoint) => { checkpoint.treeDigest = fixture.operationReceipt.accepted.treeDigest; });
    writeJson(fixture.config.negativeReceiptPath, fixture.negative);
    const local = localOnlyOverrides(fixture);
    await assert.rejects(closure.runClosureFromConfig(fixture.configPath, local.overrides), /intrusion.sequence/);
    assert.equal(local.ownershipCalls.length, 0);
    assert.equal(local.getCalls.length, 0);
});

test('one-shot closure performs one exact ownership read, five fixed GETs, and atomic publication', async (t) => {
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    const fixture = await makeClosureFixture(t);
    const local = localOnlyOverrides(fixture);
    const receipt = await closure.runClosureFromConfig(fixture.configPath, local.overrides);
    assert.equal(local.ownershipCalls.length, 1);
    assert.deepEqual([local.ownershipCalls[0].file, ...local.ownershipCalls[0].argv], receipt.ownershipRead.argv);
    assert.equal(local.ownershipCalls[0].options.cwd, fixture.project);
    assert.equal(local.ownershipCalls[0].options.shell, false);
    assert.deepEqual(local.getCalls.map(({ url }) => new URL(url).pathname), PUBLIC_PATHS);
    assert.ok(local.getCalls.every(({ options }) => options.redirect === 'manual' && options.cache === 'no-store'));
    assert.equal(receipt.status, 'VERIFIED');
    assert.equal(fs.existsSync(fixture.config.closureReceiptPath), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.config.closureReceiptPath, 'utf8')), receipt);
    assert.deepEqual(receipt.finalAliasProbe.bodyPaths, BODY_TOKENS.map((token) => `file-probes/bodies/closure-alias-${token}.bin`));
    assert.equal(fs.readdirSync(fixture.releaseRoot).some((name) => name.startsWith('.closure.stage-')), false);
});

test('ownership validation rejects identity, later-row schema, process, timeout, and prose spoof before GET', async (t) => {
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    const cases = [
        ['wrong id', (value) => { const rows = JSON.parse(value.stdout); rows[0].Id = 'wrong'; return { ...value, stdout: Buffer.from(JSON.stringify(rows)) }; }, /authority.wranglerRows.first/],
        ['malformed later row', (value) => { const rows = JSON.parse(value.stdout); rows.push({ Id: 'later' }); return { ...value, stdout: Buffer.from(JSON.stringify(rows)) }; }, /authority.wranglerRows.1/],
        ['nonzero exit', (value) => ({ ...value, status: 1 }), /closure.ownership.exitCode/],
        ['signal', (value) => ({ ...value, signal: 'SIGKILL' }), /closure.ownership.signal/],
        ['timeout', (value) => ({ ...value, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }), /closure.ownership.timeout/],
        ['prose spoof', (value) => ({ ...value, stdout: Buffer.from('PUBLIC_SMOKE_V2_GATE=6\/6') }), /closure.ownership.stdoutJson/],
    ];
    for (const [name, spawn, invariant] of cases) {
        await t.test(name, async (t) => {
            const fixture = await makeClosureFixture(t);
            const local = localOnlyOverrides(fixture, { spawn });
            await assert.rejects(closure.runClosureFromConfig(fixture.configPath, local.overrides), invariant);
            assert.equal(local.ownershipCalls.length, 1);
            assert.equal(local.getCalls.length, 0);
            assert.equal(fs.existsSync(fixture.config.closureReceiptPath), false);
        });
    }
});

test('alias validation rejects redirect, status, MIME, bytes, SHA, partial and body-path drift', async (t) => {
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    const cases = [
        ['redirect', (value) => ({ ...value, status: 302 }), /closure.alias.status/],
        ['final URL', (value) => ({ ...value, url: 'https://example.invalid/' }), /closure.alias.finalUrl/],
        ['empty MIME', (value) => ({ ...value, headers: { get: () => ' ; charset=utf-8' } }), /closure.alias.mime/],
        ['wrong MIME', (value) => ({ ...value, headers: { get: () => 'text\/plain' } }), /closure.alias.mime/],
        ['wrong bytes and SHA', (value) => ({ ...value, arrayBuffer: async () => Buffer.from('drift') }), /closure.alias.sourceBytes/],
    ];
    for (const [name, fetch, invariant] of cases) {
        await t.test(name, async (t) => {
            const fixture = await makeClosureFixture(t);
            const local = localOnlyOverrides(fixture, { fetch: (value, context) => context.index === 4 ? fetch(value) : value });
            await assert.rejects(async () => closure.runClosureFromConfig(fixture.configPath, local.overrides), invariant);
            assert.equal(local.ownershipCalls.length, 1);
            assert.equal(local.getCalls.length, 5);
            assert.equal(fs.existsSync(fixture.config.closureReceiptPath), false);
        });
    }
    await t.test('partial 4/5', async (t) => {
        const fixture = await makeClosureFixture(t);
        const local = localOnlyOverrides(fixture, { fetch: (value, context) => {
            if (context.index === 4) throw new Error('injected fifth GET failure');
            return value;
        } });
        await assert.rejects(closure.runClosureFromConfig(fixture.configPath, local.overrides), /injected fifth GET failure/);
        assert.equal(local.getCalls.length, 5);
        assert.equal(fs.existsSync(fixture.config.closureReceiptPath), false);
    });
});

test('alias deadline remains active through a hanging response body', async (t) => {
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    const fixture = await makeClosureFixture(t);
    const local = localOnlyOverrides(fixture, {
        fetch: (value, context) => ({
            ...value,
            arrayBuffer: () => new Promise((resolve, reject) => {
                context.options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
                setTimeout(() => reject(new Error('body-not-aborted')), 50);
            }),
        }),
        overrides: { requestTimeoutMs: 5 },
    });
    await assert.rejects(closure.runClosureFromConfig(fixture.configPath, local.overrides), /closure.alias.timeout/);
    assert.equal(local.getCalls.length, 1);
    assert.equal(fs.existsSync(fixture.config.closureReceiptPath), false);
});

test('CLI and publication fail closed on duplicate arguments, pre-existing output, symlink and stage collision', async (t) => {
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    const fixture = await makeClosureFixture(t);
    const local = localOnlyOverrides(fixture);
    await assert.rejects(closure.runClosureFromArgv([], local.overrides), /closure.argv/);
    await assert.rejects(closure.runClosureFromArgv(['--config', fixture.configPath, '--config', fixture.configPath], local.overrides), /closure.argv/);
    await assert.rejects(closure.runClosureFromArgv(['--unknown', fixture.configPath], local.overrides), /closure.argv/);
    await assert.rejects(closure.runClosureFromArgv(['--config', 'relative.json'], local.overrides), /config.path/);

    fs.mkdirSync(fixture.config.closureRoot, { recursive: true });
    fs.writeFileSync(path.join(fixture.config.closureRoot, 'foreign.txt'), 'foreign');
    await assert.rejects(closure.runClosureFromConfig(fixture.configPath, local.overrides), /closureRoot.exists/);
    assert.equal(fs.readFileSync(path.join(fixture.config.closureRoot, 'foreign.txt'), 'utf8'), 'foreign');
});

test('a colliding foreign stage is preserved byte-for-byte and is never promoted to diagnostics', async (t) => {
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    const fixture = await makeClosureFixture(t);
    const local = localOnlyOverrides(fixture);
    const foreignStage = path.join(path.dirname(fixture.config.closureRoot), `.${path.basename(fixture.config.closureRoot)}.stage-${'a'.repeat(32)}`);
    fs.mkdirSync(foreignStage);
    fs.writeFileSync(path.join(foreignStage, 'foreign.txt'), 'foreign-stage');
    fs.writeFileSync(path.join(foreignStage, 'receipt.json'), 'foreign-receipt');
    await assert.rejects(closure.runClosureFromConfig(fixture.configPath, local.overrides), /EEXIST/);
    assert.equal(fs.readFileSync(path.join(foreignStage, 'foreign.txt'), 'utf8'), 'foreign-stage');
    assert.equal(fs.readFileSync(path.join(foreignStage, 'receipt.json'), 'utf8'), 'foreign-receipt');
    assert.equal(fs.existsSync(path.join(foreignStage, 'diagnostic.json')), false);
    assert.equal(local.ownershipCalls.length, 0);
    assert.equal(local.getCalls.length, 0);
});

test('write, fsync, and rename failures publish diagnostics without a receipt and preserve a foreign final', async (t) => {
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    for (const failure of ['write', 'fsync', 'rename']) {
        await t.test(failure, async (t) => {
            const fixture = await makeClosureFixture(t);
            const local = localOnlyOverrides(fixture);
            const method = failure === 'write' ? 'writeFileSync' : failure === 'fsync' ? 'fsyncSync' : 'renameSync';
            const original = fs[method];
            let injected = false;
            fs[method] = function (...args) {
                if (!injected) {
                    injected = true;
                    if (failure === 'rename') {
                        fs.mkdirSync(fixture.config.closureRoot);
                        fs.writeFileSync(path.join(fixture.config.closureRoot, 'foreign.txt'), 'foreign-final');
                    }
                    throw new Error(`${failure}-injected`);
                }
                return original.apply(this, args);
            };
            try {
                await assert.rejects(closure.runClosureFromConfig(fixture.configPath, local.overrides), new RegExp(`${failure}-injected`));
            } finally {
                fs[method] = original;
            }
            assert.equal(fs.existsSync(fixture.config.closureReceiptPath), false);
            if (failure === 'rename') assert.equal(fs.readFileSync(path.join(fixture.config.closureRoot, 'foreign.txt'), 'utf8'), 'foreign-final');
        });
    }
});

test('post-rename parent fsync failure rolls back the same-identity closure into one diagnostic', async (t) => {
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    const fixture = await makeClosureFixture(t);
    const local = localOnlyOverrides(fixture);
    const originalRename = fs.renameSync;
    const originalFsync = fs.fsyncSync;
    let finalRenamed = false;
    let injected = false;
    fs.renameSync = function (source, destination) {
        const result = originalRename.call(this, source, destination);
        if (path.resolve(destination) === path.resolve(fixture.config.closureRoot)) finalRenamed = true;
        return result;
    };
    fs.fsyncSync = function (...args) {
        if (finalRenamed && !injected) {
            injected = true;
            throw new Error('parent-fsync-after-final-rename');
        }
        return originalFsync.apply(this, args);
    };
    try {
        await assert.rejects(closure.runClosureFromConfig(fixture.configPath, local.overrides), /parent-fsync-after-final-rename/);
    } finally {
        fs.renameSync = originalRename;
        fs.fsyncSync = originalFsync;
    }
    const siblings = fs.readdirSync(fixture.releaseRoot);
    const diagnostics = siblings.filter((name) => name.startsWith(`${path.basename(fixture.config.closureRoot)}-failure-`));
    assert.equal(fs.existsSync(fixture.config.closureRoot), false);
    assert.equal(fs.existsSync(fixture.config.closureReceiptPath), false);
    assert.equal(siblings.some((name) => name.startsWith(`.${path.basename(fixture.config.closureRoot)}.stage-`)), false);
    assert.equal(diagnostics.length, 1);
    assert.equal(fs.existsSync(path.join(fixture.releaseRoot, diagnostics[0], 'receipt.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.releaseRoot, diagnostics[0], 'diagnostic.json'), 'utf8')).status, 'FAILED');
});

test('post-rename recovery preserves a foreign replacement and publishes one separate diagnostic', async (t) => {
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    const fixture = await makeClosureFixture(t);
    const local = localOnlyOverrides(fixture);
    const originalRename = fs.renameSync;
    const originalFsync = fs.fsyncSync;
    let finalRenamed = false;
    let injected = false;
    fs.renameSync = function (source, destination) {
        const result = originalRename.call(this, source, destination);
        if (path.resolve(destination) === path.resolve(fixture.config.closureRoot)) finalRenamed = true;
        return result;
    };
    fs.fsyncSync = function (...args) {
        if (finalRenamed && !injected) {
            injected = true;
            fs.rmSync(fixture.config.closureRoot, { recursive: true });
            fs.mkdirSync(fixture.config.closureRoot);
            fs.writeFileSync(path.join(fixture.config.closureRoot, 'foreign.txt'), 'foreign-replacement');
            throw new Error('parent-fsync-with-foreign-replacement');
        }
        return originalFsync.apply(this, args);
    };
    try {
        await assert.rejects(closure.runClosureFromConfig(fixture.configPath, local.overrides), /parent-fsync-with-foreign-replacement/);
    } finally {
        fs.renameSync = originalRename;
        fs.fsyncSync = originalFsync;
    }
    const diagnostics = fs.readdirSync(fixture.releaseRoot).filter((name) => name.startsWith(`${path.basename(fixture.config.closureRoot)}-failure-`));
    assert.equal(fs.readFileSync(path.join(fixture.config.closureRoot, 'foreign.txt'), 'utf8'), 'foreign-replacement');
    assert.equal(fs.existsSync(fixture.config.closureReceiptPath), false);
    assert.equal(diagnostics.length, 1);
    assert.equal(fs.existsSync(path.join(fixture.releaseRoot, diagnostics[0], 'receipt.json')), false);
});

test('post-rename recovery reports cleanup parent fsync failure after removing the success path', async (t) => {
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    const fixture = await makeClosureFixture(t);
    const local = localOnlyOverrides(fixture);
    const originalRename = fs.renameSync;
    const originalFsync = fs.fsyncSync;
    let finalRenamed = false;
    let diagnosticRenamed = false;
    let publicationInjected = false;
    let cleanupInjected = false;
    fs.renameSync = function (source, destination) {
        const result = originalRename.call(this, source, destination);
        if (path.resolve(destination) === path.resolve(fixture.config.closureRoot)) finalRenamed = true;
        if (path.resolve(source) === path.resolve(fixture.config.closureRoot) && path.basename(destination).startsWith(`${path.basename(fixture.config.closureRoot)}-failure-`)) diagnosticRenamed = true;
        return result;
    };
    fs.fsyncSync = function (...args) {
        if (finalRenamed && !publicationInjected) {
            publicationInjected = true;
            throw new Error('parent-fsync-after-final-rename');
        }
        if (diagnosticRenamed && !cleanupInjected) {
            cleanupInjected = true;
            throw new Error('cleanup-parent-fsync');
        }
        return originalFsync.apply(this, args);
    };
    try {
        await assert.rejects(closure.runClosureFromConfig(fixture.configPath, local.overrides), /parent-fsync-after-final-rename; closure\.diagnostic=cleanup-parent-fsync/);
    } finally {
        fs.renameSync = originalRename;
        fs.fsyncSync = originalFsync;
    }
    const siblings = fs.readdirSync(fixture.releaseRoot);
    const diagnostics = siblings.filter((name) => name.startsWith(`${path.basename(fixture.config.closureRoot)}-failure-`));
    assert.equal(fs.existsSync(fixture.config.closureRoot), false);
    assert.equal(siblings.some((name) => name.startsWith(`.${path.basename(fixture.config.closureRoot)}.stage-`)), false);
    assert.equal(diagnostics.length, 1);
    assert.equal(fs.existsSync(path.join(fixture.releaseRoot, diagnostics[0], 'receipt.json')), false);
});

test('a symlinked closure output is rejected before ownership and remains untouched', async (t) => {
    const closure = await import('../../scripts/close-public-smoke-v2.mjs');
    const fixture = await makeClosureFixture(t);
    const foreign = path.join(fixture.releaseRoot, 'foreign-closure');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'foreign.txt'), 'foreign');
    fs.symlinkSync(foreign, fixture.config.closureRoot, 'junction');
    const local = localOnlyOverrides(fixture);
    await assert.rejects(closure.runClosureFromConfig(fixture.configPath, local.overrides), /symlink/);
    assert.equal(fs.readFileSync(path.join(foreign, 'foreign.txt'), 'utf8'), 'foreign');
    assert.equal(local.ownershipCalls.length, 0);
    assert.equal(local.getCalls.length, 0);
});
