#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    NEGATIVE_CONTROL_REGISTRY,
    auditAcceptedRun,
    canonicalJson,
    sha256File,
    validateAuditReceipt,
    validateManifest,
    validateNegativeReceipt,
    validateOperationConfig,
} from './public-smoke-v2-lib.mjs';

const AUDITOR_TIMEOUT_MS = 120000;
const SUCCESS_GATE = /(?:^|\r?\n)PUBLIC_SMOKE_V2_GATE=/;

function fail(invariant, detail = '') {
    throw new Error(`${invariant}${detail ? `: ${detail}` : ''}`);
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(file, invariant) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        fail(invariant, error.message);
    }
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: 'wx' });
}

function replaceJson(file, value) {
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function copyTreeWithoutSymlinks(source, destination) {
    const sourceStat = fs.lstatSync(source);
    if (sourceStat.isSymbolicLink()) fail('negative.copy.symlink', source);
    if (!sourceStat.isDirectory()) fail('negative.copy.source', source);
    fs.mkdirSync(destination);
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name);
        const to = path.join(destination, entry.name);
        if (entry.isSymbolicLink()) fail('negative.copy.symlink', from);
        if (entry.isDirectory()) copyTreeWithoutSymlinks(from, to);
        else if (entry.isFile()) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        else fail('negative.copy.regular', from);
    }
}

function manifestFor(root, releaseId) {
    const files = [];
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
            const absolute = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) fail('negative.manifest.symlink', absolute);
            if (entry.isDirectory()) walk(absolute);
            else if (entry.isFile()) {
                const relative = path.relative(root, absolute).split(path.sep).join('/');
                if (relative === 'artifact-manifest.json') continue;
                const bytes = fs.readFileSync(absolute);
                files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
            } else fail('negative.manifest.regular', absolute);
        }
    }
    walk(root);
    files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    const manifest = { schemaVersion: 1, releaseId, files };
    manifest.manifestPayloadSha256 = sha256(canonicalJson(manifest));
    return manifest;
}

function resealManifest(root) {
    const manifestPath = path.join(root, 'artifact-manifest.json');
    const current = readJson(manifestPath, 'negative.manifest');
    const manifest = manifestFor(root, current.releaseId);
    replaceJson(manifestPath, manifest);
    validateManifest(root, manifest);
    return manifest;
}

function rehashEvents(events) {
    let previousEventSha256 = '0'.repeat(64);
    events.forEach((event, index) => {
        event.seq = index + 1;
        event.previousEventSha256 = previousEventSha256;
        const unhashed = { ...event };
        delete unhashed.eventSha256;
        event.eventSha256 = sha256(canonicalJson(unhashed));
        previousEventSha256 = event.eventSha256;
    });
}

function syncScreenshotEvent(events, screenshot) {
    const written = events.find((event) => event.case === screenshot.caseLabel && event.type === 'screenshot-written' && event.payload?.stage === screenshot.stage);
    if (!written) fail('negative.screenshot.event', `${screenshot.caseLabel}/${screenshot.stage}`);
    written.payload.path = screenshot.relativePath;
    written.payload.pngSha256 = screenshot.sha256;
    written.payload.oracleSha256 = screenshot.oracleSnapshotSha256;
    const oracle = events.find((event) => event.case === screenshot.caseLabel && event.type === 'screenshot-oracle' && event.payload?.stage === screenshot.stage);
    if (oracle) oracle.payload.oracleSha256 = screenshot.oracleSnapshotSha256;
}

function changeNibble(value) {
    return `${value[0] === '0' ? '1' : '0'}${value.slice(1)}`;
}

export function applyNegativeControlMutation(acceptedRoot, controlId) {
    const observationsPath = path.join(acceptedRoot, 'observations.json');
    const observations = readJson(observationsPath, 'negative.observations');
    const first = observations[0];
    let observationsChanged = true;

    if (controlId === 'NC01_INTRUSION_SEQUENCE_BROKEN') first.intrusions[1].type = 'copilot';
    else if (controlId === 'NC02_PENALTY_DELTA_BROKEN') first.penalty.after.stars += 1;
    else if (controlId === 'NC03_RECOVER_UNITS_BROKEN') first.recoveries[0].after.units += 1;
    else if (controlId === 'NC04_ENDING_ACCESSIBLE_NAME_BROKEN') first.ending.accessibleName += '!';
    else if (controlId === 'NC05_CLOUDFLARE_PRE_ID_DRIFT') {
        observationsChanged = false;
        const stdoutPath = path.join(acceptedRoot, 'control-plane', 'pre.stdout.bin');
        const rows = JSON.parse(fs.readFileSync(stdoutPath, 'utf8'));
        rows[0].Id = rows[0].Id === 'feedface-1234-5678-9abc-def012345678' ? 'deadbeef-1234-5678-9abc-def012345678' : 'feedface-1234-5678-9abc-def012345678';
        const bytes = Buffer.from(`${JSON.stringify(rows)}\n`);
        fs.writeFileSync(stdoutPath, bytes);
        const capturePath = path.join(acceptedRoot, 'control-plane', 'pre.command.json');
        const capture = readJson(capturePath, 'negative.cloudflare.pre');
        capture.stdoutBytes = bytes.length;
        capture.stdoutSha256 = sha256(bytes);
        replaceJson(capturePath, capture);
    } else if (controlId === 'NC06_FINAL_ALIAS_SCRIPT_DRIFT') {
        observationsChanged = false;
        const probePath = path.join(acceptedRoot, 'file-probes', 'final-alias-5.json');
        const probe = readJson(probePath, 'negative.fileProbe.finalAlias');
        const script = probe.results.find((result) => result.path === '/script.js');
        if (!script) fail('negative.fileProbe.finalAlias.script');
        script.sha256 = changeNibble(script.sha256);
        replaceJson(probePath, probe);
    } else if (controlId === 'NC07_SCREENSHOT_CASE_SWAP_REHASHED' || controlId === 'NC08_SCREENSHOT_COPY_REHASHED') {
        const destinationCase = observations.find((record) => record.label === 'firefox-alias');
        const sourceCase = observations.find((record) => record.label === 'chromium-immutable');
        const stage = controlId === 'NC07_SCREENSHOT_CASE_SWAP_REHASHED' ? 'initial' : 'progress';
        const destination = destinationCase?.screenshots.find((screenshot) => screenshot.stage === stage);
        const source = sourceCase?.screenshots.find((screenshot) => screenshot.stage === stage);
        if (!destination || !source) fail('negative.screenshot.tuple', stage);
        const destinationPath = path.join(acceptedRoot, destination.relativePath);
        const sourcePath = path.join(acceptedRoot, source.relativePath);
        const destinationBytes = fs.readFileSync(destinationPath);
        const sourceBytes = fs.readFileSync(sourcePath);
        const destinationOracleSha256 = destination.oracleSnapshotSha256;
        const sourceOracleSha256 = source.oracleSnapshotSha256;
        fs.writeFileSync(destinationPath, sourceBytes);
        destination.bytes = sourceBytes.length;
        destination.sha256 = sha256(sourceBytes);
        destination.oracleSnapshotSha256 = sourceOracleSha256;
        if (controlId === 'NC07_SCREENSHOT_CASE_SWAP_REHASHED') {
            fs.writeFileSync(sourcePath, destinationBytes);
            source.bytes = destinationBytes.length;
            source.sha256 = sha256(destinationBytes);
            source.oracleSnapshotSha256 = destinationOracleSha256;
        }
        const eventsPath = path.join(acceptedRoot, 'runner-events.jsonl');
        const text = fs.readFileSync(eventsPath, 'utf8');
        const events = text.trimEnd().split(/\r?\n/).map((line) => JSON.parse(line));
        syncScreenshotEvent(events, destination);
        if (controlId === 'NC07_SCREENSHOT_CASE_SWAP_REHASHED') syncScreenshotEvent(events, source);
        rehashEvents(events);
        fs.writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    } else if (controlId === 'NC09_SIGNATURE_ROAST_BROKEN') first.signature.roast += '!';
    else if (controlId === 'NC10_QUOTE_RELOAD_PERSISTENCE_BROKEN') first.quotePersistence.afterReload.counter = 0;
    else if (controlId === 'NC11_ENDING_DISPLAY_NONE') first.ending.visibility.display = 'none';
    else if (controlId === 'NC12_FAILED_REQUEST_INJECTED') {
        const baseUrl = first.requestedUrl ?? first.finalUrl ?? 'https://01234567.penguin-exit-0.pages.dev/';
        first.errors.requestFailed.push({ url: new URL('/script.js', baseUrl).href, method: 'GET', errorText: 'net::ERR_FAILED' });
    } else fail('negative.controlId', controlId);

    if (observationsChanged) replaceJson(observationsPath, observations);
    resealManifest(acceptedRoot);
}

function pristineState(acceptedDir) {
    const manifestPath = path.join(acceptedDir, 'artifact-manifest.json');
    const manifest = validateManifest(acceptedDir, readJson(manifestPath, 'negative.pristineManifest'));
    const manifestSha256 = sha256File(manifestPath);
    return { manifestSha256, treeDigest: sha256(canonicalJson({ files: manifest.files, manifestSha256 })) };
}

function fsyncDirectory(directory, fsImpl, platform) {
    const descriptor = fsImpl.openSync(directory, 'r');
    try { fsImpl.fsyncSync(descriptor); }
    catch (error) { if (platform !== 'win32' || error?.code !== 'EPERM') throw error; }
    finally { fsImpl.closeSync(descriptor); }
}

function pathEntryExists(file) {
    try { fs.lstatSync(file); return true; }
    catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function pathEntryExistsWith(file, fsImpl) {
    try { fsImpl.lstatSync(file); return true; }
    catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

export function publishNegativeReceiptExclusive(file, bytes, { fsImpl = fs, platform = process.platform, publicationGuard = () => {}, randomUUID = () => crypto.randomUUID() } = {}) {
    if (fsImpl.existsSync(file)) fail('negativeReceiptPath.exists');
    const directory = path.dirname(file);
    fsImpl.mkdirSync(directory, { recursive: true });
    const temporaryToken = crypto.randomBytes(16).toString('hex');
    const temporary = path.join(directory, `.${path.basename(file)}.tmp-${temporaryToken}`);
    let linked = false;
    let temporaryIdentity;
    try {
        publicationGuard();
        const descriptor = fsImpl.openSync(temporary, 'wx');
        try {
            try {
                const descriptorStat = fsImpl.fstatSync(descriptor);
                if (!descriptorStat.isFile()) fail('negativeReceiptPath.temporaryDescriptor');
                temporaryIdentity = { dev: descriptorStat.dev, ino: descriptorStat.ino };
            } catch (error) {
                try {
                    const descriptorStat = fsImpl.fstatSync(descriptor);
                    const pathStat = fsImpl.lstatSync(temporary);
                    if (descriptorStat.isFile() && pathStat.isFile() && !pathStat.isSymbolicLink() && sameIdentity(pathStat, descriptorStat)) {
                        temporaryIdentity = { dev: descriptorStat.dev, ino: descriptorStat.ino };
                    }
                } catch {}
                throw error;
            }
            fsImpl.writeFileSync(descriptor, bytes);
            fsImpl.fsyncSync(descriptor);
        } finally {
            fsImpl.closeSync(descriptor);
        }
        const temporaryStat = fsImpl.lstatSync(temporary);
        if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink() || !sameIdentity(temporaryStat, temporaryIdentity)) fail('negativeReceiptPath.temporaryIdentity');
        const temporaryBytes = fsImpl.readFileSync(temporary);
        if (!Buffer.isBuffer(temporaryBytes) || !temporaryBytes.equals(bytes) || sha256(temporaryBytes) !== sha256(bytes)) fail('negativeReceiptPath.temporaryBytes');
        publicationGuard();
        fsImpl.linkSync(temporary, file);
        linked = true;
        const finalStat = fsImpl.lstatSync(file);
        if (!finalStat.isFile() || finalStat.isSymbolicLink() || !sameIdentity(finalStat, temporaryIdentity)) fail('negativeReceiptPath.finalIdentity');
        const finalBytes = fsImpl.readFileSync(file);
        if (!Buffer.isBuffer(finalBytes) || !finalBytes.equals(bytes) || sha256(finalBytes) !== sha256(bytes)) fail('negativeReceiptPath.finalBytes');
        publicationGuard();
        fsyncDirectory(directory, fsImpl, platform);
        publicationGuard();
        const currentTemporary = fsImpl.lstatSync(temporary);
        if (!currentTemporary.isFile() || currentTemporary.isSymbolicLink() || !sameIdentity(currentTemporary, temporaryIdentity)) fail('negativeReceiptPath.temporaryIdentity');
        fsImpl.unlinkSync(temporary);
        fsyncDirectory(directory, fsImpl, platform);
        publicationGuard();
        const durableFinalStat = fsImpl.lstatSync(file);
        if (!durableFinalStat.isFile() || durableFinalStat.isSymbolicLink() || !sameIdentity(durableFinalStat, temporaryIdentity)) fail('negativeReceiptPath.finalIdentity');
        const durableFinalBytes = fsImpl.readFileSync(file);
        if (!Buffer.isBuffer(durableFinalBytes) || !durableFinalBytes.equals(bytes) || sha256(durableFinalBytes) !== sha256(bytes)) fail('negativeReceiptPath.finalBytes');
        publicationGuard();
    } catch (error) {
        let cleanupChangedDirectory = false;
        if (linked && fsImpl.existsSync(file)) {
            const finalStat = fsImpl.lstatSync(file);
            if (temporaryIdentity && finalStat.isFile() && !finalStat.isSymbolicLink() && sameIdentity(finalStat, temporaryIdentity)) {
                fsImpl.unlinkSync(file);
                cleanupChangedDirectory = true;
            } else {
                quarantineForeignPathExclusive(file, '.negative-receipt.foreign-', fsImpl, randomUUID);
                cleanupChangedDirectory = true;
            }
        }
        if (fsImpl.existsSync(temporary)) {
            const temporaryStat = fsImpl.lstatSync(temporary);
            if (temporaryIdentity && temporaryStat.isFile() && !temporaryStat.isSymbolicLink() && sameIdentity(temporaryStat, temporaryIdentity)) {
                fsImpl.unlinkSync(temporary);
                cleanupChangedDirectory = true;
            } else {
                quarantineForeignPathExclusive(temporary, '.negative-receipt.foreign-', fsImpl, randomUUID);
                cleanupChangedDirectory = true;
            }
        }
        if (linked || cleanupChangedDirectory) fsyncDirectory(directory, fsImpl, platform);
        throw error;
    }
}

function sameIdentity(stat, identity) {
    return stat.dev === identity.dev && stat.ino === identity.ino;
}

function quarantineSnapshot(file, fsImpl) {
    const stat = fsImpl.lstatSync(file);
    if (stat.isSymbolicLink()) fail('negative.quarantine.symlink');
    const identity = { dev: stat.dev, ino: stat.ino };
    if (stat.isFile()) return { type: 'file', identity, bytes: fsImpl.readFileSync(file) };
    if (!stat.isDirectory()) fail('negative.quarantine.type');
    return {
        type: 'directory',
        identity,
        entries: fsImpl.readdirSync(file).sort().map((name) => [name, quarantineSnapshot(path.join(file, name), fsImpl)]),
    };
}

function sameQuarantineSnapshot(actual, expected) {
    if (actual.type !== expected.type || !sameIdentity(actual.identity, expected.identity)) return false;
    if (actual.type === 'file') return Buffer.isBuffer(actual.bytes) && Buffer.isBuffer(expected.bytes) && actual.bytes.equals(expected.bytes);
    return actual.entries.length === expected.entries.length && actual.entries.every(([name, snapshot], index) => name === expected.entries[index][0] && sameQuarantineSnapshot(snapshot, expected.entries[index][1]));
}

function quarantineForeignPathExclusive(sourcePath, diagnosticPrefix, fsImpl, randomUUID) {
    const expected = quarantineSnapshot(sourcePath, fsImpl);
    const parent = path.dirname(sourcePath);
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const uuid = randomUUID();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) fail('negative.quarantine.uuid');
        const diagnostic = path.join(parent, `${diagnosticPrefix}${uuid}`);
        try { fsImpl.mkdirSync(diagnostic); }
        catch (error) { if (error?.code === 'EEXIST') continue; throw error; }
        if (fsImpl.readdirSync(diagnostic).length !== 0) fail('negative.quarantine.claim');
        const current = quarantineSnapshot(sourcePath, fsImpl);
        if (!sameQuarantineSnapshot(current, expected)) fail('negative.quarantine.source');
        const destination = path.join(diagnostic, path.basename(sourcePath));
        fsImpl.renameSync(sourcePath, destination);
        const quarantined = quarantineSnapshot(destination, fsImpl);
        if (!sameQuarantineSnapshot(quarantined, expected)) fail('negative.quarantine.destination');
        fsyncDirectory(diagnostic, fsImpl, process.platform);
        fsyncDirectory(parent, fsImpl, process.platform);
        return destination;
    }
    fail('negative.quarantine.collision');
}

function checkpointAuditFileName(checkpoint) {
    return `${String(checkpoint.sequence).padStart(3, '0')}-${checkpoint.controlId.toLowerCase()}-${checkpoint.phase.toLowerCase()}.json`;
}

function beginNegativeCheckpointAuditPublication(negativeReceiptPath, { fsImpl = fs, platform = process.platform, randomHex = () => crypto.randomBytes(16).toString('hex'), randomUUID = () => crypto.randomUUID() } = {}) {
    const root = path.join(path.dirname(negativeReceiptPath), 'negative-checkpoint-audits');
    if (pathEntryExistsWith(root, fsImpl)) fail('negativeCheckpointAudits.exists');
    const token = randomHex();
    if (!/^[0-9a-f]{32}$/.test(token)) fail('negativeCheckpointAudits.stageToken');
    const stage = path.join(path.dirname(root), `.${path.basename(root)}.stage-${token}`);
    let identity;
    let created = false;
    try {
        fsImpl.mkdirSync(stage);
        created = true;
        let stageStatError;
        try {
            const stageStat = fsImpl.lstatSync(stage);
            if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) fail('negativeCheckpointAudits.stage');
            identity = { dev: stageStat.dev, ino: stageStat.ino };
        } catch (error) {
            stageStatError = error;
        }
        const descriptor = fsImpl.openSync(stage, 'r');
        try {
            const descriptorStat = fsImpl.fstatSync(descriptor);
            if (!descriptorStat.isDirectory()) fail('negativeCheckpointAudits.stage');
            if (identity && !sameIdentity(descriptorStat, identity)) fail('negativeCheckpointAudits.stage');
            identity = { dev: descriptorStat.dev, ino: descriptorStat.ino };
        } finally {
            fsImpl.closeSync(descriptor);
        }
        const stageStat = fsImpl.lstatSync(stage);
        if (!stageStat.isDirectory() || stageStat.isSymbolicLink() || !sameIdentity(stageStat, identity)) fail('negativeCheckpointAudits.stage');
        if (stageStatError) throw stageStatError;
    } catch (error) {
        let removed = false;
        if (created && identity && pathEntryExistsWith(stage, fsImpl)) {
            const current = fsImpl.lstatSync(stage);
            if (current.isDirectory() && !current.isSymbolicLink() && sameIdentity(current, identity) && fsImpl.readdirSync(stage).length === 0) {
                fsImpl.rmdirSync(stage);
                removed = true;
            }
        }
        if (created && !removed && pathEntryExistsWith(stage, fsImpl)) quarantineForeignPathExclusive(stage, '.negative-checkpoint-audits.foreign-', fsImpl, randomUUID);
        if (removed) fsyncDirectory(path.dirname(stage), fsImpl, platform);
        if (error?.code === 'EEXIST') fail('negativeCheckpointAudits.stage', error.message);
        throw error;
    }
    return {
        fsImpl,
        platform,
        root,
        stage,
        parent: path.dirname(root),
        identity,
        randomUUID,
        files: new Map(),
        published: false,
    };
}

function writeNegativeCheckpointAudit(publication, checkpoint, audit) {
    const bytes = Buffer.from(`${JSON.stringify(audit)}\n`);
    if (sha256(bytes) !== checkpoint.auditReceiptSha256) fail('negativeCheckpointAudits.sha256');
    const name = checkpointAuditFileName(checkpoint);
    const file = path.join(publication.stage, name);
    const descriptor = publication.fsImpl.openSync(file, 'wx');
    try {
        try {
            const openedStat = publication.fsImpl.fstatSync(descriptor);
            if (!openedStat.isFile()) fail('negativeCheckpointAudits.file');
            publication.files.set(name, { dev: openedStat.dev, ino: openedStat.ino, bytes });
        } catch (error) {
            try {
                const openedStat = publication.fsImpl.fstatSync(descriptor);
                const pathStat = publication.fsImpl.lstatSync(file);
                if (openedStat.isFile() && pathStat.isFile() && !pathStat.isSymbolicLink() && sameIdentity(pathStat, openedStat)) {
                    publication.files.set(name, { dev: openedStat.dev, ino: openedStat.ino, bytes });
                }
            } catch {}
            throw error;
        }
        const pathStat = publication.fsImpl.lstatSync(file);
        if (!pathStat.isFile() || pathStat.isSymbolicLink() || !sameIdentity(pathStat, publication.files.get(name))) fail('negativeCheckpointAudits.file');
        publication.fsImpl.writeFileSync(descriptor, bytes);
        publication.fsImpl.fsyncSync(descriptor);
    } finally {
        publication.fsImpl.closeSync(descriptor);
    }
    const stat = publication.fsImpl.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('negativeCheckpointAudits.file');
    if (!sameIdentity(stat, publication.files.get(name))) fail('negativeCheckpointAudits.file');
}

function finalizeNegativeCheckpointAuditPublication(publication) {
    if (publication.files.size !== 25) fail('negativeCheckpointAudits.count');
    fsyncDirectory(publication.stage, publication.fsImpl, publication.platform);
    const entries = publication.fsImpl.readdirSync(publication.stage, { withFileTypes: true });
    if (entries.length !== 25 || entries.some((entry) => !entry.isFile() || !publication.files.has(entry.name))) fail('negativeCheckpointAudits.membership');
    for (const [name, record] of publication.files) {
        const stat = publication.fsImpl.lstatSync(path.join(publication.stage, name));
        if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(stat, record)) fail('negativeCheckpointAudits.file');
    }
    if (pathEntryExistsWith(publication.root, publication.fsImpl)) fail('negativeCheckpointAudits.exists');
    publication.fsImpl.renameSync(publication.stage, publication.root);
    publication.published = true;
    const finalStat = publication.fsImpl.lstatSync(publication.root);
    if (!finalStat.isDirectory() || finalStat.isSymbolicLink() || !sameIdentity(finalStat, publication.identity)) fail('negativeCheckpointAudits.identity');
    fsyncDirectory(publication.parent, publication.fsImpl, publication.platform);
}

function authenticateNegativeCheckpointAuditPublication(publication, receipt, expectedAudit) {
    const rootStat = publication.fsImpl.lstatSync(publication.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !sameIdentity(rootStat, publication.identity)) fail('negativeCheckpointAudits.identity');
    const expectedNames = receipt.checkpoints.map(checkpointAuditFileName);
    const entries = publication.fsImpl.readdirSync(publication.root, { withFileTypes: true });
    if (entries.length !== 25 || entries.some((entry) => !entry.isFile() || !expectedNames.includes(entry.name)) || new Set(entries.map(({ name }) => name)).size !== 25) fail('negativeCheckpointAudits.membership');
    return expectedNames.map((name, index) => {
        const record = publication.files.get(name);
        if (!record) fail('negativeCheckpointAudits.membership');
        const file = path.join(publication.root, name);
        const stat = publication.fsImpl.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(stat, record)) fail('negativeCheckpointAudits.file');
        const bytes = publication.fsImpl.readFileSync(file);
        if (!Buffer.isBuffer(bytes) || !bytes.equals(record.bytes) || sha256(bytes) !== receipt.checkpoints[index].auditReceiptSha256) fail('negativeCheckpointAudits.sha256');
        let audit;
        try { audit = JSON.parse(bytes.toString('utf8')); }
        catch (error) { fail('negativeCheckpointAudits.audit', error.message); }
        validateAuditReceipt(audit, expectedAudit);
        return audit;
    });
}

function rollbackNegativeCheckpointAuditPublication(publication) {
    const directory = publication.published ? publication.root : publication.stage;
    let directoryStat;
    try { directoryStat = publication.fsImpl.lstatSync(directory); }
    catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        fsyncDirectory(publication.parent, publication.fsImpl, publication.platform);
        return;
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !sameIdentity(directoryStat, publication.identity)) {
        quarantineForeignPathExclusive(directory, '.negative-checkpoint-audits.foreign-', publication.fsImpl, publication.randomUUID);
    } else {
        for (const [name, record] of publication.files) {
            const file = path.join(directory, name);
            let stat;
            try { stat = publication.fsImpl.lstatSync(file); }
            catch (error) { if (error?.code === 'ENOENT') continue; else throw error; }
            if (stat.isFile() && !stat.isSymbolicLink() && sameIdentity(stat, record)) publication.fsImpl.unlinkSync(file);
        }
        const current = publication.fsImpl.lstatSync(directory);
        if (current.isDirectory() && !current.isSymbolicLink() && sameIdentity(current, publication.identity) && publication.fsImpl.readdirSync(directory).length === 0) {
            publication.fsImpl.rmdirSync(directory);
        } else if (current.isDirectory() && !current.isSymbolicLink() && sameIdentity(current, publication.identity)) {
            quarantineForeignPathExclusive(directory, '.negative-checkpoint-audits.foreign-', publication.fsImpl, publication.randomUUID);
        }
    }
    fsyncDirectory(publication.parent, publication.fsImpl, publication.platform);
}

function failAfterCheckpointAuditRollback(error, publication) {
    try { rollbackNegativeCheckpointAuditPublication(publication); }
    catch (cleanupError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, {
            cause: new AggregateError([error, cleanupError]),
        });
    }
    throw error;
}

function ensureAuthorityUnchanged(configPath, configSha256, operationReceiptPath, operationReceiptSha256) {
    if (sha256File(configPath) !== configSha256) fail('negative.config.immutable');
    if (sha256File(operationReceiptPath) !== operationReceiptSha256) fail('negative.operationReceipt.immutable');
}

function parseAuditorResult(result, targetRealpath, expectedInvariant) {
    if (result?.error) fail('negative.auditor.launch', result.error.message);
    if (!Number.isInteger(result?.status)) fail('negative.auditor.exitCode');
    if (result.signal !== null) fail('negative.auditor.signal', String(result.signal));
    if (result.status === 0) fail('negative.auditor.exitCode');
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? '');
    const stdoutText = stdout.toString('utf8'), stderrText = stderr.toString('utf8');
    if (SUCCESS_GATE.test(stdoutText) || SUCCESS_GATE.test(stderrText)) fail('negative.auditor.successGate');
    const lines = stderrText.trimEnd().split(/\r?\n/);
    const expectedTargetLine = `AUDIT_TARGET_REALPATH=${targetRealpath}`;
    if (lines[0] !== expectedTargetLine) fail('negative.auditor.targetRealpath');
    const observedInvariant = lines[1]?.split(':', 1)[0];
    if (observedInvariant !== expectedInvariant) fail('negative.auditor.observedInvariant', observedInvariant ?? 'missing');
    return { exitCode: result.status, signal: null, stdout, stderr, emittedTargetRealpath: targetRealpath, successGateAbsent: true, observedInvariant };
}

export function runNegativeControlsFromConfig(configPath, overrides = {}) {
    if (!path.isAbsolute(configPath)) fail('config.path', 'must be absolute');
    const canonicalConfigPath = path.resolve(configPath);
    const config = validateOperationConfig(readJson(canonicalConfigPath, 'negative.config'));
    if (fs.existsSync(config.negativeReceiptPath)) fail('negativeReceiptPath.exists');
    const publicationOptions = overrides.publication ?? {};
    const checkpointAuditPublication = beginNegativeCheckpointAuditPublication(config.negativeReceiptPath, publicationOptions);
    try {
    const pristineAcceptedRealpath = fs.realpathSync(config.acceptedDir);
    const configSha256 = sha256File(canonicalConfigPath);
    const operationReceiptSha256 = sha256File(config.operationReceiptPath);
    const pristine = pristineState(pristineAcceptedRealpath);
    const auditPristine = overrides.auditPristine ?? (() => auditAcceptedRun({ configPath: canonicalConfigPath }));
    const spawnSyncImpl = overrides.spawnSyncImpl ?? spawnSync;
    const now = overrides.now ?? (() => new Date());
    const checkpoints = [];
    const checkpointAuditReceipts = [];
    let baselineAudit;

    function checkpoint(controlId, phase) {
        ensureAuthorityUnchanged(canonicalConfigPath, configSha256, config.operationReceiptPath, operationReceiptSha256);
        const current = pristineState(pristineAcceptedRealpath);
        if (current.manifestSha256 !== pristine.manifestSha256 || current.treeDigest !== pristine.treeDigest) fail('negative.pristine.checkpoint');
        const freshAudit = auditPristine({ configPath: canonicalConfigPath, controlId, phase });
        validateAuditReceipt(freshAudit, baselineAudit);
        if (freshAudit.auditedTargetRealpath !== pristineAcceptedRealpath || freshAudit.status !== 'VERIFIED') fail('negative.pristine.audit');
        if (!baselineAudit) {
            baselineAudit = structuredClone(freshAudit);
        }
        const freshAuditSha256 = sha256(Buffer.from(`${JSON.stringify(freshAudit)}\n`));
        const checkpointRow = { sequence: checkpoints.length + 1, controlId, phase, treeDigest: pristine.treeDigest, auditReceiptSha256: freshAuditSha256, auditStatus: 'VERIFIED' };
        checkpoints.push(checkpointRow);
        checkpointAuditReceipts.push(structuredClone(freshAudit));
        writeNegativeCheckpointAudit(checkpointAuditPublication, checkpointRow, freshAudit);
    }

    checkpoint('BASELINE', 'BASELINE');
    const controls = [];
    const auditorPath = path.join(config.authorityProjectRoot, 'scripts', 'verify-public-smoke-v2.mjs');
    for (const { id, expectedInvariant } of NEGATIVE_CONTROL_REGISTRY) {
        checkpoint(id, 'BEFORE');
        const mutationRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${id.toLowerCase()}-`));
        const mutationRootRealpath = fs.realpathSync(mutationRoot);
        const target = path.join(mutationRootRealpath, 'accepted');
        copyTreeWithoutSymlinks(pristineAcceptedRealpath, target);
        const targetRealpath = fs.realpathSync(target);
        if (targetRealpath === pristineAcceptedRealpath || targetRealpath !== path.join(mutationRootRealpath, 'accepted')) fail('negative.mutation.targetRealpath');
        applyNegativeControlMutation(targetRealpath, id);
        const derivedConfigPath = path.join(mutationRootRealpath, 'audit-config.json');
        const derivedConfig = {
            schemaVersion: 3,
            baseConfigPath: canonicalConfigPath,
            baseConfigSha256: configSha256,
            mutationId: id,
            mutationRootRealpath,
            auditTargetRealpath: targetRealpath,
            externalOperationReceiptPath: config.operationReceiptPath,
            auditReceiptPath: path.join(mutationRootRealpath, 'audit-receipt.json'),
        };
        writeJson(derivedConfigPath, derivedConfig);
        if (pathEntryExists(derivedConfig.auditReceiptPath)) fail('negative.auditor.auditReceiptPath.preexisting');
        const auditorArgv = [config.nodeExePath, auditorPath, '--config', derivedConfigPath];
        const result = spawnSyncImpl(auditorArgv[0], auditorArgv.slice(1), {
            cwd: config.authorityProjectRoot,
            shell: false,
            timeout: AUDITOR_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 64 * 1024 * 1024,
            encoding: null,
        });
        if (pathEntryExists(derivedConfig.auditReceiptPath)) fail('negative.auditor.auditReceiptPath.published');
        const captured = parseAuditorResult(result, targetRealpath, expectedInvariant);
        fs.writeFileSync(path.join(mutationRootRealpath, 'auditor.stdout.bin'), captured.stdout, { flag: 'wx' });
        fs.writeFileSync(path.join(mutationRootRealpath, 'auditor.stderr.bin'), captured.stderr, { flag: 'wx' });
        controls.push({
            id,
            expectedInvariant,
            derivedConfigSha256: sha256File(derivedConfigPath),
            mutationRootRealpath,
            targetRealpath,
            auditorArgv,
            exitCode: captured.exitCode,
            signal: captured.signal,
            stdoutSha256: sha256(captured.stdout),
            stderrSha256: sha256(captured.stderr),
            emittedTargetRealpath: captured.emittedTargetRealpath,
            successGateAbsent: captured.successGateAbsent,
            observedInvariant: captured.observedInvariant,
        });
        checkpoint(id, 'AFTER');
    }
    ensureAuthorityUnchanged(canonicalConfigPath, configSha256, config.operationReceiptPath, operationReceiptSha256);
    const receipt = {
        schemaVersion: 1,
        releaseId: config.releaseId,
        status: 'VERIFIED',
        createdUtc: now().toISOString(),
        configSha256,
        operationReceiptSha256,
        pristineManifestSha256: pristine.manifestSha256,
        pristineTreeDigest: pristine.treeDigest,
        initialPristineAuditReceiptSha256: checkpoints[0].auditReceiptSha256,
        finalPristineAuditReceiptSha256: checkpoints.at(-1).auditReceiptSha256,
        checkpoints,
        controls,
    };
    const negativeExpected = { pristineAcceptedRealpath, nodeExePath: config.nodeExePath, auditorPath };
    validateNegativeReceipt(receipt, { ...negativeExpected, checkpointAuditReceipts });
    finalizeNegativeCheckpointAuditPublication(checkpointAuditPublication);
    const publicationGuard = () => {
        const materializedAudits = authenticateNegativeCheckpointAuditPublication(checkpointAuditPublication, receipt, baselineAudit);
        validateNegativeReceipt(receipt, { ...negativeExpected, checkpointAuditReceipts: materializedAudits });
    };
    publicationGuard();
    publishNegativeReceiptExclusive(config.negativeReceiptPath, Buffer.from(`${JSON.stringify(receipt)}\n`), {
        fsImpl: checkpointAuditPublication.fsImpl,
        platform: checkpointAuditPublication.platform,
        publicationGuard,
        randomUUID: checkpointAuditPublication.randomUUID,
    });
    const lines = [...NEGATIVE_CONTROL_REGISTRY.map(({ id }) => `EXPECTED_REJECTION=${id}`), 'PUBLIC_SMOKE_V2_NEGATIVE_CONTROLS=12/12'];
    return { receipt, lines };
    } catch (error) {
        failAfterCheckpointAuditRollback(error, checkpointAuditPublication);
    }
}

export function runNegativeControlsFromArgv(argv, overrides = {}) {
    if (argv.length !== 2 || argv[0] !== '--config' || !path.isAbsolute(argv[1])) fail('usage', 'run-public-smoke-v2-negative-controls.mjs --config <absolute schema-2 config>');
    return runNegativeControlsFromConfig(path.resolve(argv[1]), overrides);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    try {
        const result = runNegativeControlsFromArgv(process.argv.slice(2));
        process.stdout.write(`${result.lines.join('\n')}\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
