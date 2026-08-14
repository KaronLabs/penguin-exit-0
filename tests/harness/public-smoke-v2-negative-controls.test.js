import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as smoke from '../../scripts/public-smoke-v2-lib.mjs';

const RELEASE_ID = '20260814T000000Z-r14-public-smoke-v2';
const ZERO_SHA = '0'.repeat(64);
const REGISTRY = [
    ['NC01_INTRUSION_SEQUENCE_BROKEN', 'intrusion.sequence'],
    ['NC02_PENALTY_DELTA_BROKEN', 'penalty.starDelta'],
    ['NC03_RECOVER_UNITS_BROKEN', 'recover.unitsDelta'],
    ['NC04_ENDING_ACCESSIBLE_NAME_BROKEN', 'ending.accessibleName'],
    ['NC05_CLOUDFLARE_PRE_ID_DRIFT', 'cloudflare.preDeploymentId'],
    ['NC06_FINAL_ALIAS_SCRIPT_DRIFT', 'fileGate.finalAlias.scriptSha256'],
    ['NC07_SCREENSHOT_CASE_SWAP_REHASHED', 'screenshot.operationReceiptBinding'],
    ['NC08_SCREENSHOT_COPY_REHASHED', 'screenshot.operationReceiptBinding'],
    ['NC09_SIGNATURE_ROAST_BROKEN', 'signature.roast'],
    ['NC10_QUOTE_RELOAD_PERSISTENCE_BROKEN', 'quote.reloadPersistence'],
    ['NC11_ENDING_DISPLAY_NONE', 'ending.computedVisibility'],
    ['NC12_FAILED_REQUEST_INJECTED', 'errors.requestFailed'],
];

function sha(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function tempRoot(t, prefix = 'r14-task3-') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function manifestFor(root) {
    const files = [];
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(absolute);
            else if (entry.isFile() && path.relative(root, absolute).split(path.sep).join('/') !== 'artifact-manifest.json') {
                const bytes = fs.readFileSync(absolute);
                files.push({ path: path.relative(root, absolute).split(path.sep).join('/'), bytes: bytes.length, sha256: sha(bytes) });
            }
        }
    }
    walk(root);
    files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const manifest = { schemaVersion: 1, releaseId: RELEASE_ID, files };
    manifest.manifestPayloadSha256 = sha(smoke.canonicalJson(manifest));
    return manifest;
}

function sealAccepted(root) {
    const manifest = manifestFor(root);
    writeJson(path.join(root, 'artifact-manifest.json'), manifest);
    return manifest;
}

function rehashEvents(events) {
    let previousEventSha256 = ZERO_SHA;
    for (const [index, event] of events.entries()) {
        event.seq = index + 1;
        event.previousEventSha256 = previousEventSha256;
        const unhashed = { ...event };
        delete unhashed.eventSha256;
        event.eventSha256 = sha(smoke.canonicalJson(unhashed));
        previousEventSha256 = event.eventSha256;
    }
}

function makeMutationFixture(root) {
    const accepted = path.join(root, 'accepted');
    const screenshot = (caseLabel, stage, marker) => {
        const relativePath = `screenshots/${caseLabel}-${stage}-320.png`;
        const bytes = Buffer.from(marker);
        fs.mkdirSync(path.dirname(path.join(accepted, relativePath)), { recursive: true });
        fs.writeFileSync(path.join(accepted, relativePath), bytes);
        return { caseLabel, stage, relativePath, bytes: bytes.length, sha256: sha(bytes), oracleSnapshotSha256: sha(`${marker}-oracle`) };
    };
    const chromiumInitial = screenshot('chromium-immutable', 'initial', 'chromium-initial');
    const chromiumProgress = screenshot('chromium-immutable', 'progress', 'chromium-progress');
    const firefoxInitial = screenshot('firefox-alias', 'initial', 'firefox-initial');
    const firefoxProgress = screenshot('firefox-alias', 'progress', 'firefox-progress');
    const baseCase = {
        label: 'chromium-immutable',
        intrusions: [{}, { type: 'codex' }],
        penalty: { before: { stars: 750 }, after: { stars: 250 }, starDelta: -500 },
        recoveries: [{ before: { units: 200 }, after: { units: 200 } }],
        ending: { accessibleName: '프로세스는 살아남았습니다', visibility: { display: 'flex' } },
        signature: { roast: '아콘 🐧 // 내 할머니도 너보단 코딩을 잘하겠다.' },
        quotePersistence: { afterReload: { counter: 1 } },
        errors: { requestFailed: [] },
        screenshots: [chromiumInitial, chromiumProgress],
    };
    const observations = [baseCase, { ...structuredClone(baseCase), label: 'firefox-alias', screenshots: [firefoxInitial, firefoxProgress] }];
    writeJson(path.join(accepted, 'observations.json'), observations);

    const events = observations.flatMap((record) => record.screenshots.map((shot) => ({
        utc: '2026-08-14T00:00:00.000Z', monotonicMs: 1, type: 'screenshot-written', case: record.label,
        payload: { stage: shot.stage, path: shot.relativePath, pngSha256: shot.sha256, oracleSha256: shot.oracleSnapshotSha256 },
    })));
    rehashEvents(events);
    fs.writeFileSync(path.join(accepted, 'runner-events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

    const preRows = [{ Id: '01234567-89ab-cdef-0123-456789abcdef' }];
    const preBytes = Buffer.from(`${JSON.stringify(preRows)}\n`);
    fs.mkdirSync(path.join(accepted, 'control-plane'), { recursive: true });
    fs.writeFileSync(path.join(accepted, 'control-plane', 'pre.stdout.bin'), preBytes);
    writeJson(path.join(accepted, 'control-plane', 'pre.command.json'), { stdoutBytes: preBytes.length, stdoutSha256: sha(preBytes) });
    writeJson(path.join(accepted, 'file-probes', 'final-alias-5.json'), { results: [{ path: '/script.js', sha256: 'a'.repeat(64) }] });
    sealAccepted(accepted);
    return accepted;
}

function screenshotBindings() {
    return smoke.expectedCaseLabels().flatMap((caseLabel) => ['initial', 'progress', 'ending'].map((stage) => ({
        case: caseLabel,
        stage,
        path: `screenshots/${caseLabel}-${stage === 'ending' ? 'ending-640' : `${stage}-320`}.png`,
        pngSha256: '1'.repeat(64),
        oracleSha256: '2'.repeat(64),
        captureStartUtc: '2026-08-14T00:00:00.000Z',
        captureEndUtc: '2026-08-14T00:00:00.001Z',
    })));
}

function auditReceipt(target, createdUtc = '2026-08-14T00:00:00.000Z') {
    return {
        schemaVersion: 1, releaseId: RELEASE_ID, status: 'VERIFIED', createdUtc,
        auditedTargetRealpath: fs.realpathSync(target), configSha256: '3'.repeat(64), operationReceiptSha256: '4'.repeat(64),
        acceptedManifestSha256: '5'.repeat(64), eventsSha256: '6'.repeat(64), finalEventSha256: '7'.repeat(64),
        deploymentId: '01234567-89ab-cdef-0123-456789abcdef', passedCases: 6, totalCases: 6, controlPlaneReads: 3,
        initialFileGate: { passed: 10, total: 10 }, finalAliasGate: { passed: 5, total: 5 }, screenshotBindings: screenshotBindings(),
    };
}

function validNegativeReceipt(t) {
    const root = tempRoot(t, 'r14-task3-negative-receipt-');
    const pristine = path.join(root, 'pristine');
    fs.mkdirSync(pristine);
    const checkpointSha = (index) => sha(`fresh-audit-${index}`);
    const checkpoints = [{ sequence: 1, controlId: 'BASELINE', phase: 'BASELINE', treeDigest: '8'.repeat(64), auditReceiptSha256: checkpointSha(0), auditStatus: 'VERIFIED' }];
    const controls = REGISTRY.map(([id, expectedInvariant], index) => {
        const mutationRoot = path.join(root, `mutation-${index + 1}`);
        const target = path.join(mutationRoot, 'accepted');
        fs.mkdirSync(target, { recursive: true });
        const configPath = path.join(mutationRoot, 'audit-config.json');
        fs.writeFileSync(configPath, '{}\n');
        checkpoints.push(
            { sequence: index * 2 + 2, controlId: id, phase: 'BEFORE', treeDigest: '8'.repeat(64), auditReceiptSha256: checkpointSha(index * 2 + 1), auditStatus: 'VERIFIED' },
            { sequence: index * 2 + 3, controlId: id, phase: 'AFTER', treeDigest: '8'.repeat(64), auditReceiptSha256: checkpointSha(index * 2 + 2), auditStatus: 'VERIFIED' },
        );
        return {
            id, expectedInvariant, derivedConfigSha256: 'a'.repeat(64), mutationRootRealpath: fs.realpathSync(mutationRoot),
            targetRealpath: fs.realpathSync(target), auditorArgv: [process.execPath, path.join(root, 'scripts', 'verify-public-smoke-v2.mjs'), '--config', configPath],
            exitCode: 1, signal: null, stdoutSha256: sha(Buffer.alloc(0)), stderrSha256: 'b'.repeat(64),
            emittedTargetRealpath: fs.realpathSync(target), successGateAbsent: true, observedInvariant: expectedInvariant,
        };
    });
    return {
        pristine,
        receipt: {
            schemaVersion: 1, releaseId: RELEASE_ID, status: 'VERIFIED', createdUtc: '2026-08-14T00:00:00.000Z',
            configSha256: 'c'.repeat(64), operationReceiptSha256: 'd'.repeat(64), pristineManifestSha256: 'e'.repeat(64),
            pristineTreeDigest: '8'.repeat(64), initialPristineAuditReceiptSha256: checkpoints[0].auditReceiptSha256,
            finalPristineAuditReceiptSha256: checkpoints.at(-1).auditReceiptSha256,
            checkpoints, controls,
        },
    };
}

async function loadDriver() {
    try {
        return await import('../../scripts/run-public-smoke-v2-negative-controls.mjs');
    } catch (error) {
        assert.fail(`missing production interface: ${error.message}`);
    }
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

function makeDriverFixture(t, prefix) {
    const root = tempRoot(t, prefix);
    const workspace = path.join(root, 'workspace');
    const project = path.join(workspace, 'project');
    const releaseRoot = path.join(workspace, 'review', RELEASE_ID);
    const acceptedDir = makeMutationFixture(releaseRoot);
    const campaignDir = path.join(project, 'evidence', 'campaigns', '20260813T000000Z-r10-korean-release');
    const sourceSnapshotDir = path.join(campaignDir, 'source');
    const executionSourceDir = path.join(project, '.campaign-operations', '20260813T000000Z-r10-korean-release', 'source');
    fs.mkdirSync(sourceSnapshotDir, { recursive: true });
    fs.mkdirSync(executionSourceDir, { recursive: true });
    const tool = path.join(workspace, 'wrangler.js');
    fs.writeFileSync(tool, 'fixture');
    const nodeExePath = fs.realpathSync(process.execPath);
    const output = (name) => path.join(releaseRoot, name);
    const config = {
        schemaVersion: 2, releaseId: RELEASE_ID, releaseRoot, acceptedDir, failureRoot: output('failures'),
        operationReceiptPath: output('operation-receipt.json'), auditReceiptPath: output('audit.json'), negativeReceiptPath: output('negative.json'),
        closureRoot: output('closure'), closureReceiptPath: output('closure/receipt.json'), actualChromeEvidencePath: output('chrome.json'), releaseReceiptPath: output('release.json'),
        workerStdoutPath: output('worker.out'), workerStderrPath: output('worker.err'), campaignDir,
        campaignSpecPath: path.join(workspace, 'spec.md'), campaignReceiptPath: path.join(workspace, 'campaign.json'), campaignRunId: '20260813T000000Z-r10-korean-release',
        sourceSnapshotDir, executionSourceDir, authorityProjectRoot: project, authorityWorkspaceRoot: workspace,
        deploymentRecordPath: output('deployment.json'), immutableUrl: 'https://01234567.penguin-exit-0.pages.dev/', aliasUrl: 'https://penguin-exit-0.pages.dev/',
        nodeExePath, nodeExeSha256: smoke.sha256File(nodeExePath), wranglerJsPath: tool, wranglerJsSha256: smoke.sha256File(tool), projectName: 'penguin-exit-0',
    };
    const configPath = output('config.json');
    writeJson(configPath, config);
    fs.writeFileSync(config.operationReceiptPath, 'frozen operation receipt\n');
    return { acceptedDir, config, configPath, nodeExePath, project };
}

function expectedAuditorRejection(args) {
    const derived = JSON.parse(fs.readFileSync(args[2], 'utf8'));
    const expectedInvariant = REGISTRY.find(([id]) => id === derived.mutationId)[1];
    const target = fs.realpathSync(derived.auditTargetRealpath);
    return {
        derived,
        target,
        result: { status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from(`AUDIT_TARGET_REALPATH=${target}\n${expectedInvariant}\n`) },
    };
}

function checkpointAuditRoot(config) {
    return path.join(path.dirname(config.negativeReceiptPath), 'negative-checkpoint-audits');
}

function successfulDriverOverrides(acceptedDir, publication) {
    let auditCalls = 0;
    return {
        auditPristine: () => auditReceipt(acceptedDir, new Date(Date.parse('2026-08-14T00:00:00.000Z') + auditCalls++).toISOString()),
        spawnSyncImpl: (_file, args) => expectedAuditorRejection(args).result,
        now: () => new Date('2026-08-14T00:00:00.000Z'),
        publication,
    };
}

function publicationFaultFs(config, mode, foreignSource) {
    const descriptorPaths = new Map();
    const auditRoot = checkpointAuditRoot(config);
    const parent = path.dirname(auditRoot);
    const state = {
        auditDescriptorFstatSucceeded: false,
        cleanupParentFsyncs: 0,
        closedPaths: [],
        faultInjected: false,
        foreignAuditIdentity: undefined,
        foreignAuditPath: undefined,
        foreignCompanionIdentity: undefined,
        foreignReceiptBytes: undefined,
        foreignReceiptIdentity: undefined,
        foreignTemporaryIdentity: undefined,
        foreignTemporaryPath: undefined,
        ownedReceiptIdentity: undefined,
    };
    let auditRenamed = false;
    let parentFsyncsAfterRename = 0;
    let auditFstatInjected = false;
    let stageLstatInjected = false;
    let companionSwapped = false;
    let receiptTemporarySwapped = false;
    let auditFileSwapped = false;
    return new Proxy(fs, {
        get(target, property) {
            if (property === '__faultState') return state;
            if (property === 'openSync') return (file, flags, ...args) => {
                if (mode === 'receipt-write' && flags === 'wx' && path.dirname(file) === parent && path.basename(file).startsWith(`.${path.basename(config.negativeReceiptPath)}.tmp-`)) {
                    throw new Error('injected.receipt-write');
                }
                if (mode === 'companion-swap-at-receipt-open' && !companionSwapped && flags === 'wx' && path.dirname(file) === parent && path.basename(file).startsWith(`.${path.basename(config.negativeReceiptPath)}.tmp-`)) {
                    companionSwapped = true;
                    target.renameSync(auditRoot, path.join(parent, 'owned-checkpoint-audits-diagnostic'));
                    target.renameSync(foreignSource, auditRoot);
                    const replacement = target.lstatSync(auditRoot);
                    state.foreignCompanionIdentity = { dev: replacement.dev, ino: replacement.ino };
                }
                if (['stage-open', 'stage-lstat-open'].includes(mode) && !state.faultInjected && flags === 'r' && path.dirname(file) === parent && path.basename(file).startsWith('.negative-checkpoint-audits.stage-')) {
                    state.faultInjected = true;
                    throw new Error(`injected.${mode}`);
                }
                const descriptor = target.openSync(file, flags, ...args);
                descriptorPaths.set(descriptor, path.resolve(file));
                return descriptor;
            };
            if (property === 'closeSync') return (descriptor) => {
                const descriptorPath = descriptorPaths.get(descriptor);
                try { return target.closeSync(descriptor); }
                finally {
                    if (descriptorPath) state.closedPaths.push(descriptorPath);
                    descriptorPaths.delete(descriptor);
                    if (['receipt-temp-close-swap', 'receipt-temp-fstat-foreign'].includes(mode) && !receiptTemporarySwapped && descriptorPath && path.dirname(descriptorPath) === parent && path.basename(descriptorPath).startsWith(`.${path.basename(config.negativeReceiptPath)}.tmp-`)) {
                        receiptTemporarySwapped = true;
                        target.renameSync(descriptorPath, path.join(parent, 'owned-negative-receipt-diagnostic'));
                        target.renameSync(foreignSource, descriptorPath);
                        const replacement = target.lstatSync(descriptorPath);
                        state.foreignTemporaryIdentity = { dev: replacement.dev, ino: replacement.ino };
                        state.foreignTemporaryPath = descriptorPath;
                    }
                    if (mode === 'audit-file-lstat-foreign' && state.faultInjected && !auditFileSwapped && descriptorPath && path.dirname(descriptorPath).startsWith(path.join(parent, '.negative-checkpoint-audits.stage-'))) {
                        auditFileSwapped = true;
                        target.renameSync(descriptorPath, path.join(parent, 'owned-checkpoint-file-diagnostic'));
                        target.renameSync(foreignSource, descriptorPath);
                        const replacement = target.lstatSync(descriptorPath);
                        state.foreignAuditIdentity = { dev: replacement.dev, ino: replacement.ino };
                        state.foreignAuditPath = descriptorPath;
                    }
                }
            };
            if (property === 'renameSync') return (source, destination) => {
                const result = target.renameSync(source, destination);
                if (path.resolve(destination) === path.resolve(auditRoot)) auditRenamed = true;
                return result;
            };
            if (property === 'linkSync') return (source, destination) => {
                if (mode === 'receipt-link' && path.resolve(destination) === path.resolve(config.negativeReceiptPath)) throw new Error('injected.receipt-link');
                if (mode === 'companion-swap-at-receipt-link' && !companionSwapped && path.resolve(destination) === path.resolve(config.negativeReceiptPath)) {
                    companionSwapped = true;
                    target.renameSync(auditRoot, path.join(parent, 'owned-checkpoint-audits-diagnostic'));
                    target.renameSync(foreignSource, auditRoot);
                    const replacement = target.lstatSync(auditRoot);
                    state.foreignCompanionIdentity = { dev: replacement.dev, ino: replacement.ino };
                }
                return target.linkSync(source, destination);
            };
            if (property === 'fsyncSync') return (descriptor) => {
                const descriptorPath = descriptorPaths.get(descriptor);
                const receiptTemporary = descriptorPath && path.dirname(descriptorPath) === parent && path.basename(descriptorPath).startsWith(`.${path.basename(config.negativeReceiptPath)}.tmp-`);
                const stagedAudit = descriptorPath && path.dirname(descriptorPath).startsWith(path.join(parent, '.negative-checkpoint-audits.stage-'));
                if (mode === 'audit-file-fsync' && stagedAudit) throw new Error('injected.audit-file-fsync');
                if (mode === 'receipt-fsync' && receiptTemporary) throw new Error('injected.receipt-fsync');
                if (auditRenamed && descriptorPath === path.resolve(parent)) {
                    parentFsyncsAfterRename += 1;
                    if (parentFsyncsAfterRename === 1 && ['post-rename-fsync', 'cleanup-fsync', 'foreign-replacement'].includes(mode)) {
                        if (mode === 'foreign-replacement') {
                            target.rmSync(auditRoot, { recursive: true });
                            target.renameSync(foreignSource, auditRoot);
                            const replacement = target.lstatSync(auditRoot);
                            state.foreignCompanionIdentity = { dev: replacement.dev, ino: replacement.ino };
                        }
                        state.faultInjected = true;
                        throw new Error('injected.post-rename-fsync');
                    }
                    if (parentFsyncsAfterRename === 2 && mode === 'cleanup-fsync') throw new Error('injected.cleanup-fsync');
                }
                if (mode === 'receipt-final-foreign' && !state.faultInjected && descriptorPath === path.resolve(parent) && target.existsSync(config.negativeReceiptPath)) {
                    state.foreignReceiptBytes = target.readFileSync(config.negativeReceiptPath);
                    const owned = target.lstatSync(config.negativeReceiptPath);
                    state.ownedReceiptIdentity = { dev: owned.dev, ino: owned.ino };
                    const replacement = path.join(parent, 'foreign-final-negative-receipt');
                    target.writeFileSync(replacement, state.foreignReceiptBytes, { flag: 'wx' });
                    target.unlinkSync(config.negativeReceiptPath);
                    target.renameSync(replacement, config.negativeReceiptPath);
                    const foreign = target.lstatSync(config.negativeReceiptPath);
                    state.foreignReceiptIdentity = { dev: foreign.dev, ino: foreign.ino };
                    state.faultInjected = true;
                    throw new Error('injected.receipt-final-foreign');
                }
                if (state.faultInjected && descriptorPath === path.resolve(parent)) state.cleanupParentFsyncs += 1;
                return target.fsyncSync(descriptor);
            };
            if (property === 'fstatSync') return (descriptor) => {
                const descriptorPath = descriptorPaths.get(descriptor);
                const stagedAudit = descriptorPath && path.dirname(descriptorPath).startsWith(path.join(parent, '.negative-checkpoint-audits.stage-'));
                const stagedRoot = descriptorPath && path.dirname(descriptorPath) === parent && path.basename(descriptorPath).startsWith('.negative-checkpoint-audits.stage-');
                const receiptTemporary = descriptorPath && path.dirname(descriptorPath) === parent && path.basename(descriptorPath).startsWith(`.${path.basename(config.negativeReceiptPath)}.tmp-`);
                if (['receipt-temp-fstat', 'receipt-temp-fstat-foreign'].includes(mode) && receiptTemporary && !state.faultInjected) {
                    state.faultInjected = true;
                    throw new Error('injected.receipt-temp-fstat');
                }
                if (mode === 'stage-fstat' && stagedRoot && !state.faultInjected) {
                    state.faultInjected = true;
                    throw new Error('injected.stage-fstat');
                }
                if (['audit-file-lstat', 'audit-file-lstat-foreign'].includes(mode) && stagedAudit) state.auditDescriptorFstatSucceeded = true;
                if (mode === 'audit-file-fstat' && stagedAudit && !auditFstatInjected) {
                    auditFstatInjected = true;
                    throw new Error('injected.audit-file-fstat');
                }
                return target.fstatSync(descriptor);
            };
            if (property === 'lstatSync') return (file, ...args) => {
                const absolute = path.resolve(file);
                const stagedRoot = path.dirname(absolute) === parent && path.basename(absolute).startsWith('.negative-checkpoint-audits.stage-');
                const stagedAudit = path.dirname(absolute).startsWith(path.join(parent, '.negative-checkpoint-audits.stage-'));
                if (['audit-file-lstat', 'audit-file-lstat-foreign'].includes(mode) && stagedAudit && !state.faultInjected) {
                    const descriptor = [...descriptorPaths].find(([, descriptorPath]) => descriptorPath === absolute)?.[0];
                    if (descriptor !== undefined && !state.auditDescriptorFstatSucceeded) {
                        const descriptorStat = target.fstatSync(descriptor);
                        state.auditDescriptorFstatSucceeded = descriptorStat.isFile();
                    }
                    state.faultInjected = true;
                    throw new Error('injected.audit-file-lstat');
                }
                if (['stage-lstat', 'stage-lstat-open'].includes(mode) && stagedRoot && !stageLstatInjected) {
                    stageLstatInjected = true;
                    throw new Error(`injected.${mode}`);
                }
                return target.lstatSync(file, ...args);
            };
            return Reflect.get(target, property);
        },
    });
}

function assertNoOwnedPublicationResidue(config) {
    assert.deepEqual(publicationInventory(config), {
        companionFinal: false,
        companionStages: [],
        receiptFinal: false,
        receiptTemps: [],
    });
}

function publicationInventory(config) {
    const names = fs.readdirSync(path.dirname(config.negativeReceiptPath));
    return {
        companionFinal: fs.existsSync(checkpointAuditRoot(config)),
        companionStages: names.filter((name) => name.startsWith('.negative-checkpoint-audits.stage-')).sort(),
        receiptFinal: fs.existsSync(config.negativeReceiptPath),
        receiptTemps: names.filter((name) => name.startsWith(`.${path.basename(config.negativeReceiptPath)}.tmp-`)).sort(),
    };
}

function secondDirectoryFsyncFailure(finalPath, replaceWithForeign) {
    const calls = [];
    const owned = { dev: 1, ino: 100, type: 'file', bytes: Buffer.from('{}\n') };
    const foreign = { dev: 1, ino: 200, type: 'file', bytes: Buffer.from('{}\n') };
    const entries = new Map();
    let directoryFsyncs = 0;
    let nextIno = 300;
    const stat = (entry) => ({ ...entry, isFile: () => entry.type === 'file', isDirectory: () => entry.type === 'directory', isSymbolicLink: () => false });
    const fsImpl = {
        existsSync: (file) => entries.has(file),
        mkdirSync: (file, options) => {
            if (options?.recursive) return;
            if (entries.has(file)) { const error = new Error('exists'); error.code = 'EEXIST'; throw error; }
            entries.set(file, { dev: 1, ino: nextIno++, type: 'directory' });
        },
        openSync: (file, flags) => {
            if (flags === 'wx') { entries.set(file, owned); return `temp:${file}`; }
            return 'directory';
        },
        writeFileSync: () => {},
        fstatSync: () => stat(owned),
        fsyncSync: (descriptor) => {
            if (descriptor !== 'directory') { calls.push('fsync-temp'); return; }
            directoryFsyncs += 1;
            calls.push(`fsync-directory-${directoryFsyncs}`);
            if (directoryFsyncs === 2) {
                if (replaceWithForeign) entries.set(finalPath, foreign);
                throw new Error('second parent fsync');
            }
        },
        closeSync: () => {},
        linkSync: (temporary, file) => { entries.set(file, entries.get(temporary)); calls.push('link'); },
        lstatSync: (file) => stat(entries.get(file)),
        readFileSync: (file) => entries.get(file)?.bytes ?? Buffer.from('{}\n'),
        readdirSync: (directory) => [...entries.keys()].filter((file) => path.dirname(file) === directory).map((file) => path.basename(file)),
        unlinkSync: (file) => { calls.push(file === finalPath ? 'unlink-final' : 'unlink-temp'); entries.delete(file); },
    };
    return { calls, entries, foreign, fsImpl };
}

test('library exposes the exact ordered negative-control registry and recursive receipt validator', () => {
    assert.equal(typeof smoke.validateNegativeReceipt, 'function', 'missing validateNegativeReceipt production interface');
    assert.deepEqual(smoke.NEGATIVE_CONTROL_REGISTRY.map(({ id, expectedInvariant }) => [id, expectedInvariant]), REGISTRY);
});

test('negative receipt validator rejects nested drift, ordering drift, and false child success', (t) => {
    assert.equal(typeof smoke.validateNegativeReceipt, 'function', 'missing validateNegativeReceipt production interface');
    const { receipt, pristine } = validNegativeReceipt(t);
    assert.equal(smoke.validateNegativeReceipt(receipt, { pristineAcceptedRealpath: fs.realpathSync(pristine) }), receipt);
    for (const [label, mutate, invariant] of [
        ['unknown checkpoint key', (copy) => { copy.checkpoints[0].attacker = true; }, /negativeReceipt\.checkpoint/],
        ['wrong registry order', (copy) => { [copy.controls[0], copy.controls[1]] = [copy.controls[1], copy.controls[0]]; }, /negativeReceipt\.controls\.order/],
        ['pristine target', (copy) => { copy.controls[0].targetRealpath = fs.realpathSync(pristine); copy.controls[0].emittedTargetRealpath = fs.realpathSync(pristine); }, /negativeReceipt\.control\.targetRealpath/],
        ['zero child exit', (copy) => { copy.controls[0].exitCode = 0; }, /negativeReceipt\.control\.exitCode/],
        ['signal', (copy) => { copy.controls[0].signal = 'SIGTERM'; }, /negativeReceipt\.control\.signal/],
        ['success gate', (copy) => { copy.controls[0].successGateAbsent = false; }, /negativeReceipt\.control\.successGateAbsent/],
        ['wrong invariant', (copy) => { copy.controls[0].observedInvariant = 'manifest.file.hash'; }, /negativeReceipt\.control\.observedInvariant/],
        ['checkpoint drift', (copy) => { copy.checkpoints[7].treeDigest = 'f'.repeat(64); }, /negativeReceipt\.checkpoint\.treeDigest/],
        ['audit status', (copy) => { copy.checkpoints[7].auditStatus = 'FAILED'; }, /negativeReceipt\.checkpoint\.auditStatus/],
    ]) {
        const copy = structuredClone(receipt);
        mutate(copy);
        assert.throws(() => smoke.validateNegativeReceipt(copy, { pristineAcceptedRealpath: fs.realpathSync(pristine) }), invariant, label);
    }
});

test('negative receipt validator rejects a hostile reuse of all twelve mutation roots, targets, and derived-config paths', (t) => {
    const { receipt, pristine } = validNegativeReceipt(t);
    const first = receipt.controls[0];
    for (const control of receipt.controls.slice(1)) {
        control.mutationRootRealpath = first.mutationRootRealpath;
        control.targetRealpath = first.targetRealpath;
        control.emittedTargetRealpath = first.emittedTargetRealpath;
        control.auditorArgv[3] = first.auditorArgv[3];
    }
    assert.throws(
        () => smoke.validateNegativeReceipt(receipt, { pristineAcceptedRealpath: fs.realpathSync(pristine) }),
        /negativeReceipt\.controls\.unique/,
    );
});

test('negative receipt binds distinct initial and final audits to the first and last of 25 fresh checkpoints', (t) => {
    const { receipt, pristine } = validNegativeReceipt(t);
    receipt.checkpoints.forEach((checkpoint, index) => { checkpoint.auditReceiptSha256 = sha(`fresh-audit-${index}`); });
    receipt.initialPristineAuditReceiptSha256 = receipt.checkpoints[0].auditReceiptSha256;
    receipt.finalPristineAuditReceiptSha256 = receipt.checkpoints.at(-1).auditReceiptSha256;
    assert.notEqual(receipt.initialPristineAuditReceiptSha256, receipt.finalPristineAuditReceiptSha256);
    assert.equal(smoke.validateNegativeReceipt(receipt, { pristineAcceptedRealpath: fs.realpathSync(pristine) }), receipt);
});

test('negative receipt validator rejects 25 replayed checkpoint audit hashes', (t) => {
    const { receipt, pristine } = validNegativeReceipt(t);
    const replayedSha256 = receipt.checkpoints[0].auditReceiptSha256;
    receipt.checkpoints.forEach((checkpoint) => { checkpoint.auditReceiptSha256 = replayedSha256; });
    receipt.initialPristineAuditReceiptSha256 = replayedSha256;
    receipt.finalPristineAuditReceiptSha256 = replayedSha256;
    assert.throws(
        () => smoke.validateNegativeReceipt(receipt, { pristineAcceptedRealpath: fs.realpathSync(pristine) }),
        /negativeReceipt\.checkpoints\.unique/,
    );
});

test('Task2 signature keeps the NC09 roast invariant without weakening fairPing provenance', () => {
    const fairCommand = 'archon@stone-igloo:~$ ping 8.8.8.8';
    const fairSystem = '64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=14.2 ms\n케이블이 빠져 있었습니다. 네트워크를 복구했습니다.';
    const fairRoast = '아콘 🐧 // 지식은 레버리지가 아니다 애송아.';
    const signature = {
        command: 'archon@stone-igloo:~$ systemctl restart nginx', commandKind: 'command',
        system: 'Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.', systemKind: 'system',
        roast: '아콘 🐧 // 내 할머니도 너보단 코딩을 잘하겠다.!', roastKind: 'archon', pseudoLabel: '"ARCHON // ROAST"',
        tabs: { wifiAriaSelected: 'false', wifiTabIndex: '-1', cpuAriaSelected: 'true', cpuTabIndex: '0', panelAriaLabelledby: 'tab-cpu', terminalRowsPersisted: true },
        fairPing: {
            command: fairCommand, commandKind: 'command', system: fairSystem, systemKind: 'system', roast: fairRoast, roastKind: 'archon',
            provenance: { beforeRowCount: 3, rows: [
                { text: fairCommand, kind: 'command', context: '', index: '', pseudoLabel: 'none' },
                { text: fairSystem, kind: 'system', context: '', index: '', pseudoLabel: 'none' },
                { text: fairRoast, kind: 'archon', context: 'puzzle', index: '1', pseudoLabel: '"ARCHON // ROAST"' },
            ] },
        },
    };
    assert.throws(() => smoke.validateTask2Signature(signature), /signature\.roast/);
    assert.throws(() => smoke.validateTask2Signature({ fairPing: signature.fairPing }), /task2\.fairPing\.provenance/);
});

test('all twelve real mutations change only disposable accepted evidence and reseal its manifest', async (t) => {
    const driver = await loadDriver();
    assert.equal(typeof driver.applyNegativeControlMutation, 'function', 'missing applyNegativeControlMutation production interface');
    for (const [id] of REGISTRY) {
        const root = tempRoot(t, `r14-task3-${id.toLowerCase()}-`);
        const accepted = makeMutationFixture(root);
        const before = fs.readFileSync(path.join(accepted, 'artifact-manifest.json'));
        const observationsBefore = JSON.parse(fs.readFileSync(path.join(accepted, 'observations.json'), 'utf8'));
        driver.applyNegativeControlMutation(accepted, id);
        const after = fs.readFileSync(path.join(accepted, 'artifact-manifest.json'));
        const observationsAfter = JSON.parse(fs.readFileSync(path.join(accepted, 'observations.json'), 'utf8'));
        assert.notDeepEqual(after, before, `${id} did not reseal the accepted manifest`);
        assert.doesNotThrow(() => smoke.validateManifest(accepted, JSON.parse(after)));
        if (id === 'NC01_INTRUSION_SEQUENCE_BROKEN') assert.equal(observationsAfter[0].intrusions[1].type, 'copilot');
        if (id === 'NC02_PENALTY_DELTA_BROKEN') assert.equal(observationsAfter[0].penalty.after.stars, 251);
        if (id === 'NC03_RECOVER_UNITS_BROKEN') assert.equal(observationsAfter[0].recoveries[0].after.units, 201);
        if (id === 'NC04_ENDING_ACCESSIBLE_NAME_BROKEN') assert.equal(observationsAfter[0].ending.accessibleName, '프로세스는 살아남았습니다!');
        if (id === 'NC05_CLOUDFLARE_PRE_ID_DRIFT') {
            const rows = JSON.parse(fs.readFileSync(path.join(accepted, 'control-plane', 'pre.stdout.bin'), 'utf8'));
            assert.equal(rows[0].Id, 'feedface-1234-5678-9abc-def012345678');
        }
        if (id === 'NC06_FINAL_ALIAS_SCRIPT_DRIFT') {
            const probe = JSON.parse(fs.readFileSync(path.join(accepted, 'file-probes', 'final-alias-5.json'), 'utf8'));
            assert.equal(probe.results[0].sha256, `0${'a'.repeat(63)}`);
        }
        if (id === 'NC07_SCREENSHOT_CASE_SWAP_REHASHED') {
            const sourceBefore = observationsBefore[0].screenshots.find((shot) => shot.stage === 'initial');
            const destinationBefore = observationsBefore[1].screenshots.find((shot) => shot.stage === 'initial');
            const sourceAfter = observationsAfter[0].screenshots.find((shot) => shot.stage === 'initial');
            const destinationAfter = observationsAfter[1].screenshots.find((shot) => shot.stage === 'initial');
            assert.equal(sourceAfter.sha256, destinationBefore.sha256);
            assert.equal(destinationAfter.sha256, sourceBefore.sha256);
            assert.equal(sourceAfter.oracleSnapshotSha256, destinationBefore.oracleSnapshotSha256);
            assert.equal(destinationAfter.oracleSnapshotSha256, sourceBefore.oracleSnapshotSha256);
        }
        if (id === 'NC08_SCREENSHOT_COPY_REHASHED') {
            const sourceBefore = observationsBefore[0].screenshots.find((shot) => shot.stage === 'progress');
            const destinationAfter = observationsAfter[1].screenshots.find((shot) => shot.stage === 'progress');
            assert.equal(destinationAfter.sha256, sourceBefore.sha256);
            assert.equal(destinationAfter.oracleSnapshotSha256, sourceBefore.oracleSnapshotSha256);
        }
        if (id === 'NC09_SIGNATURE_ROAST_BROKEN') assert.equal(observationsAfter[0].signature.roast.endsWith('!'), true);
        if (id === 'NC10_QUOTE_RELOAD_PERSISTENCE_BROKEN') assert.equal(observationsAfter[0].quotePersistence.afterReload.counter, 0);
        if (id === 'NC11_ENDING_DISPLAY_NONE') assert.equal(observationsAfter[0].ending.visibility.display, 'none');
        if (id === 'NC12_FAILED_REQUEST_INJECTED') assert.deepEqual(observationsAfter[0].errors.requestFailed, [{ url: 'https://01234567.penguin-exit-0.pages.dev/script.js', method: 'GET', errorText: 'net::ERR_FAILED' }]);
    }
});

test('all twelve production mutations are rejected end to end by the real auditor against a complete accepted fixture', async (t) => {
    const driver = await loadDriver();
    const createAcceptedFixture = await loadCompleteFixtureFactory();
    const auditorPath = path.resolve('scripts/verify-public-smoke-v2.mjs');
    for (const [id, expectedInvariant] of REGISTRY) {
        const fixture = createAcceptedFixture(t);
        assert.equal(smoke.auditAcceptedRun({ configPath: fixture.configPath }).status, 'VERIFIED', `${id} pristine fixture`);
        const frozenOperationReceipt = fs.readFileSync(fixture.operationReceiptPath);
        const mutationRoot = tempRoot(t, `r14-task3-e2e-${id.toLowerCase()}-`);
        const mutationRootRealpath = fs.realpathSync(mutationRoot);
        const target = path.join(mutationRootRealpath, 'accepted');
        fs.cpSync(fixture.acceptedDir, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        const targetRealpath = fs.realpathSync(target);
        driver.applyNegativeControlMutation(targetRealpath, id);
        const derivedConfigPath = path.join(mutationRootRealpath, 'audit-config.json');
        const auditReceiptPath = path.join(mutationRootRealpath, 'audit-receipt.json');
        writeJson(derivedConfigPath, {
            schemaVersion: 3,
            baseConfigPath: fixture.configPath,
            baseConfigSha256: smoke.sha256File(fixture.configPath),
            mutationId: id,
            mutationRootRealpath,
            auditTargetRealpath: targetRealpath,
            externalOperationReceiptPath: fixture.operationReceiptPath,
            auditReceiptPath,
        });

        const result = spawnSync(process.execPath, [auditorPath, '--config', derivedConfigPath], {
            cwd: path.resolve('.'), shell: false, timeout: 120000, windowsHide: true, encoding: 'utf8',
        });
        const stderrLines = result.stderr.trimEnd().split(/\r?\n/);
        assert.notEqual(result.status, 0, `${id} unexpectedly succeeded`);
        assert.equal(result.signal, null, `${id} was terminated by a signal`);
        assert.equal(stderrLines[0], `AUDIT_TARGET_REALPATH=${targetRealpath}`, `${id} target line`);
        assert.equal(stderrLines[1]?.split(':', 1)[0], expectedInvariant, `${id} first invariant`);
        assert.equal(result.stdout.includes('PUBLIC_SMOKE_V2_GATE='), false, `${id} emitted a success gate`);
        assert.equal(fs.existsSync(auditReceiptPath), false, `${id} published an audit receipt`);
        assert.deepEqual(fs.readFileSync(fixture.operationReceiptPath), frozenOperationReceipt, `${id} changed the frozen operation receipt`);
    }
});

test('negative receipt publication durably orders link, parent fsync, temp unlink, parent fsync and applies the Windows EPERM policy', async () => {
    const driver = await loadDriver();
    assert.equal(typeof driver.publishNegativeReceiptExclusive, 'function', 'missing publishNegativeReceiptExclusive production interface');
    const calls = [];
    let directoryOpenCount = 0;
    const fsImpl = {
        existsSync: () => false,
        mkdirSync: () => {},
        openSync: (_file, flags) => flags === 'wx' ? 'temp' : `directory-${++directoryOpenCount}`,
        writeFileSync: () => {},
        fstatSync: () => ({ dev: 1, ino: 1, isFile: () => true }),
        fsyncSync: (descriptor) => { calls.push(`fsync:${descriptor}`); },
        closeSync: () => {},
        linkSync: () => { calls.push('link'); },
        lstatSync: () => ({ dev: 1, ino: 1, isFile: () => true, isSymbolicLink: () => false }),
        readFileSync: () => Buffer.from('{}\n'),
        unlinkSync: () => { calls.push('unlink-temp'); },
    };
    driver.publishNegativeReceiptExclusive(path.resolve('negative.json'), Buffer.from('{}\n'), { fsImpl, platform: 'linux' });
    assert.deepEqual(calls, ['fsync:temp', 'link', 'fsync:directory-1', 'unlink-temp', 'fsync:directory-2']);

    const windowsFs = { ...fsImpl, fsyncSync: (descriptor) => {
        if (descriptor !== 'temp') { const error = new Error('directory fsync unsupported'); error.code = 'EPERM'; throw error; }
    } };
    assert.doesNotThrow(() => driver.publishNegativeReceiptExclusive(path.resolve('negative-windows.json'), Buffer.from('{}\n'), { fsImpl: windowsFs, platform: 'win32' }));
    assert.throws(() => driver.publishNegativeReceiptExclusive(path.resolve('negative-linux.json'), Buffer.from('{}\n'), { fsImpl: windowsFs, platform: 'linux' }), /directory fsync unsupported/);
});

test('second parent fsync failure removes only the task-owned final and fsyncs the cleanup', async () => {
    const driver = await loadDriver();
    const finalPath = path.resolve('negative-owned.json');
    const { calls, entries, fsImpl } = secondDirectoryFsyncFailure(finalPath, false);
    assert.throws(() => driver.publishNegativeReceiptExclusive(finalPath, Buffer.from('{}\n'), { fsImpl, platform: 'linux' }), /second parent fsync/);
    assert.deepEqual(calls, ['fsync-temp', 'link', 'fsync-directory-1', 'unlink-temp', 'fsync-directory-2', 'unlink-final', 'fsync-directory-3']);
    assert.equal(entries.has(finalPath), false);
});

test('second parent fsync failure preserves a foreign replacement in the configured path', async () => {
    const driver = await loadDriver();
    const finalPath = path.resolve('negative-foreign.json');
    const { calls, entries, foreign, fsImpl } = secondDirectoryFsyncFailure(finalPath, true);
    assert.throws(() => driver.publishNegativeReceiptExclusive(finalPath, Buffer.from('{}\n'), { fsImpl, platform: 'linux' }), /second parent fsync/);
    assert.deepEqual(entries.get(finalPath), foreign);
    assert.equal(calls.includes('unlink-final'), false);
    assert.equal(calls.filter((call) => call.startsWith('fsync-directory-')).length, 3);
});

test('driver rejects 25 replayed audit objects without success lines or a final negative receipt', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-replayed-audits-');
    const replayedAudit = auditReceipt(acceptedDir);
    let successLines;
    assert.throws(() => {
        successLines = driver.runNegativeControlsFromConfig(configPath, {
            auditPristine: () => replayedAudit,
            spawnSyncImpl: (_file, args) => expectedAuditorRejection(args).result,
        }).lines;
    }, /negativeReceipt\.checkpoints\.unique/);
    assert.equal(successLines, undefined);
    assert.equal(fs.existsSync(config.negativeReceiptPath), false);
});

test('driver rejects a hostile child-created audit receipt before accepting its expected rejection', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-hostile-child-');
    let auditCalls = 0;
    let successLines;
    assert.throws(() => {
        successLines = driver.runNegativeControlsFromConfig(configPath, {
            auditPristine: () => auditReceipt(acceptedDir, new Date(Date.parse('2026-08-14T00:00:00.000Z') + auditCalls++).toISOString()),
            spawnSyncImpl: (_file, args) => {
                const rejection = expectedAuditorRejection(args);
                writeJson(rejection.derived.auditReceiptPath, { attacker: true });
                return rejection.result;
            },
        }).lines;
    }, /negative\.auditor\.auditReceiptPath/);
    assert.equal(successLines, undefined);
    assert.equal(fs.existsSync(config.negativeReceiptPath), false);
});

test('driver rejects a success gate smuggled after the exact target and invariant on auditor stderr', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-stderr-gate-');
    let auditCalls = 0;
    let spawnCount = 0;
    let successLines;
    assert.throws(() => {
        successLines = driver.runNegativeControlsFromConfig(configPath, {
            auditPristine: () => auditReceipt(acceptedDir, new Date(Date.parse('2026-08-14T00:00:00.000Z') + auditCalls++).toISOString()),
            spawnSyncImpl: (_file, args) => {
                spawnCount += 1;
                const { result } = expectedAuditorRejection(args);
                const exactTargetAndInvariant = result.stderr.toString('utf8').trimEnd();
                return {
                    ...result,
                    stderr: Buffer.from(`${exactTargetAndInvariant}\nPUBLIC_SMOKE_V2_GATE=6/6 manifest_sha256=${'0'.repeat(64)} release=${RELEASE_ID}\n`),
                };
            },
        }).lines;
    }, /negative\.auditor\.successGate/);
    assert.equal(spawnCount, 1);
    assert.equal(successLines, undefined);
    assert.equal(fs.existsSync(config.negativeReceiptPath), false);
});

test('actual Task3 producer publishes the exact consumer-ready set of 25 checkpoint audit objects', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-checkpoint-audits-');
    let auditCalls = 0;
    const result = driver.runNegativeControlsFromConfig(configPath, {
        auditPristine: () => auditReceipt(acceptedDir, new Date(Date.parse('2026-08-14T00:00:00.000Z') + auditCalls++).toISOString()),
        spawnSyncImpl: (_file, args) => expectedAuditorRejection(args).result,
        now: () => new Date('2026-08-14T00:00:00.000Z'),
    });
    const auditRoot = path.join(path.dirname(config.negativeReceiptPath), 'negative-checkpoint-audits');
    const expectedNames = result.receipt.checkpoints.map((checkpoint) => (
        `${String(checkpoint.sequence).padStart(3, '0')}-${checkpoint.controlId.toLowerCase()}-${checkpoint.phase.toLowerCase()}.json`
    ));

    assert.equal(fs.existsSync(auditRoot), true, 'actual Task3 output has no checkpoint-audit companion set for Task4');
    assert.deepEqual(fs.readdirSync(auditRoot).sort(), [...expectedNames].sort());
    expectedNames.forEach((name, index) => {
        const file = path.join(auditRoot, name);
        const stat = fs.lstatSync(file);
        assert.equal(stat.isFile(), true, name);
        assert.equal(stat.isSymbolicLink(), false, name);
        assert.equal(sha(fs.readFileSync(file)), result.receipt.checkpoints[index].auditReceiptSha256, name);
    });
});

test('checkpoint companion pre-existence and deterministic stage collisions fail before audits or mutations', async (t) => {
    const driver = await loadDriver();
    for (const kind of ['directory', 'file', 'junction']) {
        const { acceptedDir, config, configPath } = makeDriverFixture(t, `r14-task3-preexisting-${kind}-`);
        const auditRoot = checkpointAuditRoot(config);
        let preservedTarget;
        if (kind === 'directory') fs.mkdirSync(auditRoot);
        else if (kind === 'file') fs.writeFileSync(auditRoot, 'foreign\n');
        else {
            preservedTarget = path.join(path.dirname(auditRoot), 'foreign-audits');
            fs.mkdirSync(preservedTarget);
            fs.writeFileSync(path.join(preservedTarget, 'marker'), 'foreign\n');
            fs.symlinkSync(preservedTarget, auditRoot, 'junction');
        }
        let auditCalls = 0;
        let spawnCalls = 0;
        assert.throws(() => driver.runNegativeControlsFromConfig(configPath, {
            auditPristine: () => { auditCalls += 1; return auditReceipt(acceptedDir); },
            spawnSyncImpl: () => { spawnCalls += 1; throw new Error('must not spawn'); },
        }), /negativeCheckpointAudits\.exists/);
        assert.equal(auditCalls, 0, kind);
        assert.equal(spawnCalls, 0, kind);
        assert.equal(fs.existsSync(config.negativeReceiptPath), false, kind);
        assert.equal(fs.lstatSync(auditRoot).isSymbolicLink(), kind === 'junction', kind);
        if (preservedTarget) assert.equal(fs.readFileSync(path.join(preservedTarget, 'marker'), 'utf8'), 'foreign\n');
    }

    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-stage-collision-');
    const token = 'a'.repeat(32);
    const stage = path.join(path.dirname(checkpointAuditRoot(config)), `.negative-checkpoint-audits.stage-${token}`);
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, 'foreign'), 'preserve\n');
    let auditCalls = 0;
    assert.throws(() => driver.runNegativeControlsFromConfig(configPath, {
        ...successfulDriverOverrides(acceptedDir, { randomHex: () => token }),
        auditPristine: () => { auditCalls += 1; return auditReceipt(acceptedDir); },
    }), /EEXIST|negativeCheckpointAudits\.stage/);
    assert.equal(auditCalls, 0);
    assert.equal(fs.readFileSync(path.join(stage, 'foreign'), 'utf8'), 'preserve\n');
    assert.equal(fs.existsSync(config.negativeReceiptPath), false);
});

test('post-rename and receipt write, link, or fsync failures leave neither receipt nor owned companion residue', async (t) => {
    const driver = await loadDriver();
    for (const mode of ['audit-file-fsync', 'post-rename-fsync', 'receipt-write', 'receipt-link', 'receipt-fsync']) {
        const { acceptedDir, config, configPath } = makeDriverFixture(t, `r14-task3-${mode}-`);
        const fsImpl = publicationFaultFs(config, mode);
        assert.throws(
            () => driver.runNegativeControlsFromConfig(configPath, successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform })),
            new RegExp(`injected\\.${mode}`),
            mode,
        );
        assertNoOwnedPublicationResidue(config);
    }
});

test('cleanup fsync failure is surfaced after removing the failed run publication', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-cleanup-fsync-');
    const fsImpl = publicationFaultFs(config, 'cleanup-fsync');
    assert.throws(
        () => driver.runNegativeControlsFromConfig(configPath, successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform })),
        /injected\.post-rename-fsync.*injected\.cleanup-fsync/,
    );
    assertNoOwnedPublicationResidue(config);
});

test('post-rename rollback preserves a foreign replacement and does not publish a receipt', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-foreign-replacement-');
    const foreignSource = path.join(path.dirname(config.negativeReceiptPath), 'foreign-checkpoint-audits');
    fs.mkdirSync(foreignSource);
    fs.writeFileSync(path.join(foreignSource, 'marker'), 'foreign\n');
    const fsImpl = publicationFaultFs(config, 'foreign-replacement', foreignSource);
    let successLines;
    assert.throws(() => {
        successLines = driver.runNegativeControlsFromConfig(configPath, successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform })).lines;
    }, /injected\.post-rename-fsync/);
    assert.equal(successLines, undefined);
    assert.deepEqual(publicationInventory(config), {
        companionFinal: true,
        companionStages: [],
        receiptFinal: false,
        receiptTemps: [],
    });
    assert.equal(fs.readFileSync(path.join(checkpointAuditRoot(config), 'marker'), 'utf8'), 'foreign\n');
    const finalStat = fs.lstatSync(checkpointAuditRoot(config));
    assert.deepEqual({ dev: finalStat.dev, ino: finalStat.ino }, fsImpl.__faultState.foreignCompanionIdentity);
});

test('receipt temp first descriptor fstat failure closes and durably removes the whole owned publication inventory', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-receipt-temp-fstat-');
    const fsImpl = publicationFaultFs(config, 'receipt-temp-fstat');
    let successLines;
    assert.throws(() => {
        successLines = driver.runNegativeControlsFromConfig(configPath, successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform })).lines;
    }, /injected\.receipt-temp-fstat/);
    assert.equal(successLines, undefined);
    assert.equal(fsImpl.__faultState.closedPaths.some((file) => path.basename(file).startsWith(`.${path.basename(config.negativeReceiptPath)}.tmp-`)), true);
    assertNoOwnedPublicationResidue(config);
    assert.equal(fsImpl.__faultState.cleanupParentFsyncs >= 2, true);
});

test('receipt temp first fstat failure preserves a foreign replacement in the temporary path', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-receipt-temp-fstat-foreign-');
    const parent = path.dirname(config.negativeReceiptPath);
    const foreignSource = path.join(parent, 'foreign-negative-receipt-fstat');
    fs.writeFileSync(foreignSource, 'foreign-receipt-fstat\n');
    const fsImpl = publicationFaultFs(config, 'receipt-temp-fstat-foreign', foreignSource);
    let successLines;
    assert.throws(() => {
        successLines = driver.runNegativeControlsFromConfig(configPath, successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform })).lines;
    }, /injected\.receipt-temp-fstat/);
    assert.equal(successLines, undefined);
    const inventory = publicationInventory(config);
    assert.equal(inventory.companionFinal, false);
    assert.deepEqual(inventory.companionStages, []);
    assert.equal(inventory.receiptFinal, false);
    assert.deepEqual(inventory.receiptTemps, [path.basename(fsImpl.__faultState.foreignTemporaryPath)]);
    assert.equal(fs.readFileSync(fsImpl.__faultState.foreignTemporaryPath, 'utf8'), 'foreign-receipt-fstat\n');
    const temporaryStat = fs.lstatSync(fsImpl.__faultState.foreignTemporaryPath);
    assert.deepEqual({ dev: temporaryStat.dev, ino: temporaryStat.ino }, fsImpl.__faultState.foreignTemporaryIdentity);
});

test('stage directory first open failure stops before audits and durably removes the exact publication inventory', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-stage-open-');
    const fsImpl = publicationFaultFs(config, 'stage-open');
    let auditCalls = 0;
    let spawnCalls = 0;
    assert.throws(() => driver.runNegativeControlsFromConfig(configPath, {
        ...successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform }),
        auditPristine: () => { auditCalls += 1; return auditReceipt(acceptedDir); },
        spawnSyncImpl: () => { spawnCalls += 1; throw new Error('unexpected spawn'); },
    }), /injected\.stage-open/);
    assert.equal(auditCalls, 0);
    assert.equal(spawnCalls, 0);
    assertNoOwnedPublicationResidue(config);
    assert.equal(fsImpl.__faultState.cleanupParentFsyncs >= 1, true);
});

test('stage directory first descriptor fstat failure closes and durably removes the exact publication inventory', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-stage-fstat-');
    const fsImpl = publicationFaultFs(config, 'stage-fstat');
    let auditCalls = 0;
    assert.throws(() => driver.runNegativeControlsFromConfig(configPath, {
        ...successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform }),
        auditPristine: () => { auditCalls += 1; return auditReceipt(acceptedDir); },
    }), /injected\.stage-fstat/);
    assert.equal(auditCalls, 0);
    assert.equal(fsImpl.__faultState.closedPaths.some((file) => path.basename(file).startsWith('.negative-checkpoint-audits.stage-')), true);
    assertNoOwnedPublicationResidue(config);
    assert.equal(fsImpl.__faultState.cleanupParentFsyncs >= 1, true);
});

test('checkpoint descriptor identity survives the first path lstat failure and leaves zero owned inventory', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-audit-file-lstat-');
    const fsImpl = publicationFaultFs(config, 'audit-file-lstat');
    let successLines;
    assert.throws(() => {
        successLines = driver.runNegativeControlsFromConfig(configPath, successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform })).lines;
    }, /injected\.audit-file-lstat/);
    assert.equal(successLines, undefined);
    assert.equal(fsImpl.__faultState.auditDescriptorFstatSucceeded, true);
    assert.equal(fsImpl.__faultState.closedPaths.some((file) => path.dirname(file).includes('.negative-checkpoint-audits.stage-')), true);
    assertNoOwnedPublicationResidue(config);
    assert.equal(fsImpl.__faultState.cleanupParentFsyncs >= 1, true);
});

test('checkpoint path lstat failure preserves a foreign file replacement in the live stage', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-audit-file-lstat-foreign-');
    const parent = path.dirname(config.negativeReceiptPath);
    const foreignSource = path.join(parent, 'foreign-checkpoint-file');
    fs.writeFileSync(foreignSource, 'foreign-checkpoint\n');
    const fsImpl = publicationFaultFs(config, 'audit-file-lstat-foreign', foreignSource);
    let successLines;
    assert.throws(() => {
        successLines = driver.runNegativeControlsFromConfig(configPath, successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform })).lines;
    }, /injected\.audit-file-lstat/);
    assert.equal(successLines, undefined);
    const inventory = publicationInventory(config);
    assert.equal(inventory.companionFinal, false);
    assert.equal(inventory.companionStages.length, 1);
    assert.equal(inventory.receiptFinal, false);
    assert.deepEqual(inventory.receiptTemps, []);
    assert.equal(fs.readFileSync(fsImpl.__faultState.foreignAuditPath, 'utf8'), 'foreign-checkpoint\n');
    const auditStat = fs.lstatSync(fsImpl.__faultState.foreignAuditPath);
    assert.deepEqual({ dev: auditStat.dev, ino: auditStat.ino }, fsImpl.__faultState.foreignAuditIdentity);
});

test('transient stage lstat and directory open failures reacquire and remove the self-owned empty stage', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-stage-double-acquisition-');
    const parent = path.dirname(config.negativeReceiptPath);
    const fsImpl = publicationFaultFs(config, 'stage-lstat-open');
    let auditCalls = 0;
    let spawnCalls = 0;
    assert.throws(() => driver.runNegativeControlsFromConfig(configPath, {
        ...successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform }),
        auditPristine: () => { auditCalls += 1; return auditReceipt(acceptedDir); },
        spawnSyncImpl: () => { spawnCalls += 1; throw new Error('unexpected spawn'); },
    }), /injected\.stage-lstat-open/);
    assert.equal(auditCalls, 0);
    assert.equal(spawnCalls, 0);
    assertNoOwnedPublicationResidue(config);
    assert.equal(fs.readdirSync(parent).filter((name) => name.startsWith('.negative-checkpoint-audits.foreign-')).length, 0);
    assert.equal(fsImpl.__faultState.cleanupParentFsyncs >= 1, true);
});

test('rollback preserves a foreign final companion root in place and consumes the release ID', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-final-companion-foreign-');
    const parent = path.dirname(config.negativeReceiptPath);
    const foreignSource = path.join(parent, 'foreign-final-checkpoint-audits');
    fs.mkdirSync(foreignSource);
    fs.writeFileSync(path.join(foreignSource, 'marker'), 'foreign-final-companion\n');
    const fsImpl = publicationFaultFs(config, 'foreign-replacement', foreignSource);
    let successLines;
    assert.throws(() => {
        successLines = driver.runNegativeControlsFromConfig(configPath, successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform })).lines;
    }, /injected\.post-rename-fsync/);
    assert.equal(successLines, undefined);
    assert.deepEqual(publicationInventory(config), {
        companionFinal: true,
        companionStages: [],
        receiptFinal: false,
        receiptTemps: [],
    });
    assert.equal(fs.readFileSync(path.join(checkpointAuditRoot(config), 'marker'), 'utf8'), 'foreign-final-companion\n');
    const finalStat = fs.lstatSync(checkpointAuditRoot(config));
    assert.deepEqual({ dev: finalStat.dev, ino: finalStat.ino }, fsImpl.__faultState.foreignCompanionIdentity);
    assert.equal(fsImpl.__faultState.cleanupParentFsyncs >= 1, true);
});

test('rollback preserves a byte-identical foreign final receipt without claiming the task-owned inode', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-final-receipt-foreign-');
    const fsImpl = publicationFaultFs(config, 'receipt-final-foreign');
    let successLines;
    assert.throws(() => {
        successLines = driver.runNegativeControlsFromConfig(configPath, successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform })).lines;
    }, /injected\.receipt-final-foreign/);
    assert.equal(successLines, undefined);
    assert.deepEqual(publicationInventory(config), {
        companionFinal: false,
        companionStages: [],
        receiptFinal: true,
        receiptTemps: [],
    });
    assert.deepEqual(fs.readFileSync(config.negativeReceiptPath), fsImpl.__faultState.foreignReceiptBytes);
    assert.equal(JSON.parse(fsImpl.__faultState.foreignReceiptBytes).status, 'VERIFIED');
    const finalStat = fs.lstatSync(config.negativeReceiptPath);
    assert.deepEqual({ dev: finalStat.dev, ino: finalStat.ino }, fsImpl.__faultState.foreignReceiptIdentity);
    assert.notDeepEqual(fsImpl.__faultState.foreignReceiptIdentity, fsImpl.__faultState.ownedReceiptIdentity);
    assert.equal(fsImpl.__faultState.cleanupParentFsyncs >= 1, true);
});

test('companion replacement at receipt temp open cannot publish a receipt or success gate', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-companion-receipt-race-');
    const parent = path.dirname(config.negativeReceiptPath);
    const foreignSource = path.join(parent, 'foreign-checkpoint-audits');
    fs.mkdirSync(foreignSource);
    fs.writeFileSync(path.join(foreignSource, 'marker'), 'foreign\n');
    const fsImpl = publicationFaultFs(config, 'companion-swap-at-receipt-open', foreignSource);
    let successLines;
    assert.throws(() => {
        successLines = driver.runNegativeControlsFromConfig(configPath, successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform })).lines;
    }, /negativeCheckpointAudits/);
    assert.equal(successLines, undefined);
    assert.deepEqual(publicationInventory(config), {
        companionFinal: true,
        companionStages: [],
        receiptFinal: false,
        receiptTemps: [],
    });
    assert.equal(fs.readFileSync(path.join(checkpointAuditRoot(config), 'marker'), 'utf8'), 'foreign\n');
    const finalStat = fs.lstatSync(checkpointAuditRoot(config));
    assert.deepEqual({ dev: finalStat.dev, ino: finalStat.ino }, fsImpl.__faultState.foreignCompanionIdentity);
    assert.equal(fs.readdirSync(path.join(parent, 'owned-checkpoint-audits-diagnostic')).length, 25);
});

test('companion replacement inside receipt hardlink is detected and rolls back the linked receipt', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-companion-link-race-');
    const parent = path.dirname(config.negativeReceiptPath);
    const foreignSource = path.join(parent, 'foreign-checkpoint-audits');
    fs.mkdirSync(foreignSource);
    fs.writeFileSync(path.join(foreignSource, 'marker'), 'foreign\n');
    const fsImpl = publicationFaultFs(config, 'companion-swap-at-receipt-link', foreignSource);
    let successLines;
    assert.throws(() => {
        successLines = driver.runNegativeControlsFromConfig(configPath, successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform })).lines;
    }, /negativeCheckpointAudits/);
    assert.equal(successLines, undefined);
    assert.deepEqual(publicationInventory(config), {
        companionFinal: true,
        companionStages: [],
        receiptFinal: false,
        receiptTemps: [],
    });
    assert.equal(fs.readFileSync(path.join(checkpointAuditRoot(config), 'marker'), 'utf8'), 'foreign\n');
    const finalStat = fs.lstatSync(checkpointAuditRoot(config));
    assert.deepEqual({ dev: finalStat.dev, ino: finalStat.ino }, fsImpl.__faultState.foreignCompanionIdentity);
    assert.equal(fs.readdirSync(path.join(parent, 'owned-checkpoint-audits-diagnostic')).length, 25);
});

test('first checkpoint file fstat failure closes and removes every self-owned stage entry', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-audit-fstat-');
    const fsImpl = publicationFaultFs(config, 'audit-file-fstat');
    let successLines;
    assert.throws(() => {
        successLines = driver.runNegativeControlsFromConfig(configPath, successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform })).lines;
    }, /injected\.audit-file-fstat/);
    assert.equal(successLines, undefined);
    assertNoOwnedPublicationResidue(config);
});

test('receipt temp replacement after close is never linked and the foreign bytes are preserved', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-receipt-close-race-');
    const parent = path.dirname(config.negativeReceiptPath);
    const foreignSource = path.join(parent, 'foreign-negative-receipt');
    fs.writeFileSync(foreignSource, 'foreign-receipt\n');
    const fsImpl = publicationFaultFs(config, 'receipt-temp-close-swap', foreignSource);
    let successLines;
    assert.throws(() => {
        successLines = driver.runNegativeControlsFromConfig(configPath, successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform })).lines;
    }, /negativeReceiptPath\.temporary/);
    assert.equal(successLines, undefined);
    assert.equal(fs.existsSync(config.negativeReceiptPath), false);
    assert.equal(fs.existsSync(checkpointAuditRoot(config)), false);
    const inventory = publicationInventory(config);
    assert.equal(inventory.companionFinal, false);
    assert.deepEqual(inventory.companionStages, []);
    assert.equal(inventory.receiptFinal, false);
    assert.deepEqual(inventory.receiptTemps, [path.basename(fsImpl.__faultState.foreignTemporaryPath)]);
    assert.equal(fs.readFileSync(fsImpl.__faultState.foreignTemporaryPath, 'utf8'), 'foreign-receipt\n');
    const temporaryStat = fs.lstatSync(fsImpl.__faultState.foreignTemporaryPath);
    assert.deepEqual({ dev: temporaryStat.dev, ino: temporaryStat.ino }, fsImpl.__faultState.foreignTemporaryIdentity);
    assert.equal(fs.existsSync(path.join(parent, 'owned-negative-receipt-diagnostic')), true);
});

test('stage lstat failure immediately after mkdir removes the owned empty stage and fsyncs cleanup', async (t) => {
    const driver = await loadDriver();
    const { acceptedDir, config, configPath } = makeDriverFixture(t, 'r14-task3-stage-lstat-');
    const fsImpl = publicationFaultFs(config, 'stage-lstat');
    let auditCalls = 0;
    assert.throws(() => driver.runNegativeControlsFromConfig(configPath, {
        ...successfulDriverOverrides(acceptedDir, { fsImpl, platform: process.platform }),
        auditPristine: () => { auditCalls += 1; return auditReceipt(acceptedDir); },
    }), /injected\.stage-lstat/);
    assert.equal(auditCalls, 0);
    assert.equal(fs.existsSync(config.negativeReceiptPath), false);
    assert.equal(fs.readdirSync(path.dirname(config.negativeReceiptPath)).some((name) => name.startsWith('.negative-checkpoint-audits.stage-')), false);
});

test('driver preserves 25 pristine checkpoints, exact auditor argv, bounded spawn, immutable authority, and exclusive receipt', async (t) => {
    const driver = await loadDriver();
    assert.equal(typeof driver.runNegativeControlsFromConfig, 'function', 'missing runNegativeControlsFromConfig production interface');
    const { acceptedDir, config, configPath, nodeExePath, project } = makeDriverFixture(t, 'r14-task3-driver-');
    const configBefore = smoke.sha256File(configPath);
    const operationBefore = smoke.sha256File(config.operationReceiptPath);
    let auditCalls = 0;
    const spawns = [];
    const result = driver.runNegativeControlsFromConfig(configPath, {
        auditPristine: () => {
            const createdUtc = new Date(Date.parse('2026-08-14T00:00:00.000Z') + auditCalls).toISOString();
            auditCalls += 1;
            return auditReceipt(acceptedDir, createdUtc);
        },
        spawnSyncImpl: (file, args, options) => {
            const { target, result: rejection } = expectedAuditorRejection(args);
            spawns.push({ file, args, options, target });
            return rejection;
        },
        now: () => new Date('2026-08-14T00:00:00.000Z'),
    });
    assert.equal(auditCalls, 25);
    assert.equal(spawns.length, 12);
    spawns.forEach((spawn, index) => {
        assert.equal(spawn.file, nodeExePath);
        assert.deepEqual(spawn.args.slice(0, 2), [path.join(project, 'scripts', 'verify-public-smoke-v2.mjs'), '--config']);
        assert.equal(spawn.args[2], path.join(result.receipt.controls[index].mutationRootRealpath, 'audit-config.json'));
        assert.equal(spawn.options.shell, false);
        assert.equal(spawn.options.timeout, 120000);
    });
    assert.deepEqual(result.lines, [...REGISTRY.map(([id]) => `EXPECTED_REJECTION=${id}`), 'PUBLIC_SMOKE_V2_NEGATIVE_CONTROLS=12/12']);
    assert.equal(result.receipt.checkpoints.length, 25);
    assert.equal(result.receipt.controls.length, 12);
    assert.equal(new Set(result.receipt.checkpoints.map(({ auditReceiptSha256 }) => auditReceiptSha256)).size, 25);
    assert.equal(result.receipt.initialPristineAuditReceiptSha256, result.receipt.checkpoints[0].auditReceiptSha256);
    assert.equal(result.receipt.finalPristineAuditReceiptSha256, result.receipt.checkpoints.at(-1).auditReceiptSha256);
    assert.notEqual(result.receipt.initialPristineAuditReceiptSha256, result.receipt.finalPristineAuditReceiptSha256);
    assert.equal(smoke.sha256File(configPath), configBefore);
    assert.equal(smoke.sha256File(config.operationReceiptPath), operationBefore);
    assert.equal(JSON.parse(fs.readFileSync(config.negativeReceiptPath, 'utf8')).status, 'VERIFIED');
    assert.throws(() => driver.runNegativeControlsFromConfig(configPath, { auditPristine: () => auditReceipt(acceptedDir) }), /negativeReceiptPath.*exists/);
});
