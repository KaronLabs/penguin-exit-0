import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { auditAcceptedRun, canonicalJson, enforceStrictDeadline, resolvePlaywrightAuthority, validateExecutedSnapshotBinding, validateOperationConfig, validateOperationReceipt, validateRunnerSourcePolicy, validateTask2FairPingObservations } from './public-smoke-v2-lib.mjs';
import { collectControlPlane, collectFinalProbe, collectInitialProbe } from './run-public-smoke-v2.mjs';

function sha256Bytes(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function sha256File(file) { return sha256Bytes(fs.readFileSync(file)); }

function requireProcessSuccess(result, invariant, expectedStdout = null) {
    if (!result || result.exitCode !== 0 || result.signal !== null || result.stderr !== '') throw new Error(invariant);
    if (expectedStdout !== null && result.stdout !== expectedStdout) throw new Error(invariant);
}

export async function orchestrateOperation({ operationStartedMonotonicMs, monotonicNow, runVerifier, runWorker, revalidateAccepted, authenticateAccepted = async () => {}, publishReceipt }) {
    const remaining = () => remainingOperationBudget(operationStartedMonotonicMs, monotonicNow());
    const verifier = await runVerifier(remaining());
    requireProcessSuccess(verifier, 'operation.campaignVerifier', 'R10_CAMPAIGN_GATE=VERIFIED\n');
    const worker = await runWorker(remaining());
    requireProcessSuccess(worker, 'operation.worker');
    const accepted = await revalidateAccepted(remaining());
    if (accepted.eventCount !== 518 || !Array.isArray(accepted.screenshotBindings) || accepted.screenshotBindings.length !== 18) throw new Error('operation.accepted');
    await authenticateAccepted(accepted, remaining());
    const receipt = await publishReceipt(accepted, remaining());
    remaining();
    return receipt;
}

export function parseOperationArgv(argv) {
    if (argv.length !== 2 || argv[0] !== '--config' || !path.isAbsolute(argv[1])) throw new Error('operation.argv');
    return path.resolve(argv[1]);
}

const SUCCESS_OUTPUT_KEYS = ['acceptedDir', 'failureRoot', 'operationReceiptPath', 'auditReceiptPath', 'negativeReceiptPath', 'closureRoot', 'closureReceiptPath', 'actualChromeEvidencePath', 'releaseReceiptPath', 'workerStdoutPath', 'workerStderrPath'];

export function assertOperationOutputsAbsent(config) {
    for (const key of SUCCESS_OUTPUT_KEYS) if (fs.existsSync(config[key])) throw new Error(`operation.preflight.${key}`);
    for (const [label, file] of [['campaignVerifierStdout', 'campaign-verifier.stdout.bin'], ['campaignVerifierStderr', 'campaign-verifier.stderr.bin']]) if (fs.existsSync(path.join(config.releaseRoot, file))) throw new Error(`operation.preflight.${label}`);
    return true;
}

export function remainingOperationBudget(startedMonotonicMs, nowMonotonicMs) {
    const elapsed = nowMonotonicMs - startedMonotonicMs;
    enforceStrictDeadline(elapsed, 900000, 'operation.deadline');
    return 900000 - elapsed;
}

function fsyncDirectory(directory) {
    const descriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(descriptor); }
    catch (error) { if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error; }
    finally { fs.closeSync(descriptor); }
}

export function publishOperationReceiptAtomically({ receiptPath, bytes, operationStartedMonotonicMs, monotonicNow }) {
    const directory = path.dirname(receiptPath);
    const tempPath = path.join(directory, `.${path.basename(receiptPath)}.tmp-${crypto.randomBytes(16).toString('hex')}`);
    let linked = false;
    try {
        const descriptor = fs.openSync(tempPath, 'wx');
        try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
        finally { fs.closeSync(descriptor); }
        remainingOperationBudget(operationStartedMonotonicMs, monotonicNow());
        fs.linkSync(tempPath, receiptPath);
        linked = true;
        fsyncDirectory(directory);
        remainingOperationBudget(operationStartedMonotonicMs, monotonicNow());
        fs.unlinkSync(tempPath);
        fsyncDirectory(directory);
        return receiptPath;
    } catch (error) {
        if (linked && fs.existsSync(receiptPath) && fs.existsSync(tempPath)) {
            const finalStat = fs.lstatSync(receiptPath), tempStat = fs.lstatSync(tempPath);
            if (finalStat.isFile() && !finalStat.isSymbolicLink() && finalStat.dev === tempStat.dev && finalStat.ino === tempStat.ino) fs.unlinkSync(receiptPath);
        }
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        throw error;
    }
}

export function validateExecutionSeal(config, stageDir) {
    if (sha256File(config.nodeExePath) !== config.nodeExeSha256 || sha256File(config.wranglerJsPath) !== config.wranglerJsSha256) throw new Error('operation.seal.tooling');
    const expectedParent = path.resolve(config.releaseRoot);
    if (!fs.existsSync(stageDir) || path.dirname(path.resolve(stageDir)) !== expectedParent || !/^\.public-smoke-v2\.stage-[a-f0-9]{32}$/.test(path.basename(stageDir)) || fs.lstatSync(stageDir).isSymbolicLink() || fs.realpathSync(stageDir) !== path.resolve(stageDir)) throw new Error('operation.seal.stage');
    return true;
}

export function validatePreflightSeal(config) {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    for (const relative of ['scripts/run-public-smoke-v2-operation.mjs', 'scripts/run-public-smoke-v2.mjs', 'scripts/public-smoke-v2-lib.mjs', 'package.json']) {
        validateExecutedSnapshotBinding(path.join(scriptDir, '..', ...relative.split('/')), path.join(config.sourceSnapshotDir, ...relative.split('/')));
    }
    resolvePlaywrightAuthority(config.sourceSnapshotDir);
    if (sha256File(config.nodeExePath) !== config.nodeExeSha256 || sha256File(config.wranglerJsPath) !== config.wranglerJsSha256) throw new Error('operation.seal.tooling');
    return true;
}

function processArgv(config, configPath) {
    const verifierPath = path.join(config.sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs');
    const runnerPath = path.join(config.sourceSnapshotDir, 'scripts', 'run-public-smoke-v2.mjs');
    return {
        verifierPath,
        verifier: [config.nodeExePath, verifierPath, '--campaign', config.campaignDir, '--spec', config.campaignSpecPath, '--source', config.sourceSnapshotDir, '--execution-source', config.executionSourceDir, '--run', config.campaignRunId, '--authority-project', config.authorityProjectRoot, '--authority-workspace', config.authorityWorkspaceRoot],
        worker: [config.nodeExePath, runnerPath, '--config', configPath],
    };
}

function trustedStageIdentity(stageDir, releaseRoot) {
    if (typeof stageDir !== 'string' || typeof releaseRoot !== 'string') return null;
    const resolved = path.resolve(stageDir);
    if (path.dirname(resolved) !== path.resolve(releaseRoot) || !/^\.public-smoke-v2\.stage-[a-f0-9]{32}$/.test(path.basename(resolved)) || !fs.existsSync(resolved)) return null;
    const stat = fs.lstatSync(resolved);
    return stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(resolved) === resolved ? resolved : null;
}

async function moveFailedWorkerStage(stageDir, failureRoot) {
    if (!stageDir || !fs.existsSync(stageDir)) return null;
    const successManifest = path.join(stageDir, 'artifact-manifest.json');
    if (fs.existsSync(successManifest)) {
        const stat = fs.lstatSync(successManifest);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('operation.recovery.manifest');
        fs.unlinkSync(successManifest);
        fsyncDirectory(stageDir);
    }
    await fs.promises.mkdir(failureRoot, { recursive: true });
    const destination = path.join(failureRoot, `failure-${new Date().toISOString().replaceAll(/[-:.]/g, '')}-${crypto.randomBytes(8).toString('hex')}`);
    await fs.promises.rename(stageDir, destination);
    return destination;
}

function trustedRenamedAccepted(acceptedDir, pinnedIdentity, releaseId) {
    try {
        if (!acceptedDir || !pinnedIdentity || !fs.existsSync(acceptedDir)) return null;
        const resolved = path.resolve(acceptedDir), stat = fs.lstatSync(resolved);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved || stat.dev !== pinnedIdentity.dev || stat.ino !== pinnedIdentity.ino) return null;
        for (const name of ['accepted-run.json', 'artifact-manifest.json']) {
            const file = path.join(resolved, name), fileStat = fs.lstatSync(file);
            if (!fileStat.isFile() || fileStat.isSymbolicLink() || JSON.parse(fs.readFileSync(file, 'utf8')).releaseId !== releaseId) return null;
        }
        return resolved;
    } catch { return null; }
}

async function recoverFailedWorkerPublication({ pinnedStage, pinnedIdentity, acceptedDir, releaseId, failureRoot }) {
    if (pinnedStage && fs.existsSync(pinnedStage)) return moveFailedWorkerStage(pinnedStage, failureRoot);
    const accepted = trustedRenamedAccepted(acceptedDir, pinnedIdentity, releaseId);
    return accepted ? moveFailedWorkerStage(accepted, failureRoot) : null;
}

export async function recoverAcceptedPublication({ acceptedDir, failureRoot, releaseId, pinnedIdentity }) {
    const accepted = trustedRenamedAccepted(acceptedDir, pinnedIdentity, releaseId);
    return accepted ? moveFailedWorkerStage(accepted, failureRoot) : null;
}

export async function runPostWorkerGates({ revalidateAccepted, createReceipt, validateReceipt, authenticateAccepted, publishReceipt, recoverAccepted }) {
    try {
        const validated = await revalidateAccepted();
        const receipt = createReceipt(validated);
        await validateReceipt(receipt);
        await authenticateAccepted(receipt);
        await publishReceipt(receipt);
        return receipt;
    } catch (error) {
        await recoverAccepted();
        throw error;
    }
}

async function defaultSpawnProcess({ argv, cwd, stdoutPath, stderrPath, phaseAuthority, timeoutMs = 900000, releaseRoot, failureRoot, acceptedDir, releaseId }) {
    await fs.promises.mkdir(path.dirname(stdoutPath), { recursive: true });
    const stdout = fs.createWriteStream(stdoutPath, { flags: 'wx' });
    const stderr = fs.createWriteStream(stderrPath, { flags: 'wx' });
    return new Promise((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, windowsHide: true, stdio: phaseAuthority ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
        let pinnedStage = null;
        let pinnedIdentity = null;
        let forcedFailure = false;
        const kill = () => { forcedFailure = true; child.kill('SIGKILL'); };
        const watchdog = setTimeout(kill, timeoutMs);
        child.once('error', reject);
        if (phaseAuthority) child.on('message', async (message) => {
            const match = /^READY_(INITIAL|MID|POST)$/.exec(message?.type ?? '');
            const expected = ['INITIAL', 'MID', 'POST'][child.__phaseIndex ?? 0];
            if (!match || match[1] !== expected) { kill(); return; }
            const identity = trustedStageIdentity(message.stageDir, releaseRoot);
            if (!identity || (pinnedStage !== null && identity !== pinnedStage)) { kill(); return; }
            if (pinnedStage === null) {
                pinnedStage = identity;
                const stat = fs.lstatSync(identity);
                pinnedIdentity = { dev: stat.dev, ino: stat.ino };
            }
            child.__phaseIndex = (child.__phaseIndex ?? 0) + 1;
            const phase = match[1].toLowerCase();
            try { child.send({ type: `ACK_${match[1]}`, payload: await phaseAuthority(phase, message.stageDir) }); }
            catch (error) { child.send({ type: `ACK_${match[1]}`, error: error.message }); }
        });
        child.stdout.pipe(stdout);
        child.stderr.pipe(stderr);
        child.once('close', (exitCode, signal) => { clearTimeout(watchdog); return Promise.all([
            new Promise((done) => stdout.end(done)),
            new Promise((done) => stderr.end(done)),
            (forcedFailure || exitCode !== 0 || signal !== null) && pinnedStage && failureRoot ? recoverFailedWorkerPublication({ pinnedStage, pinnedIdentity, acceptedDir, releaseId, failureRoot }) : null,
        ]).then(() => resolve({ exitCode, signal, pinnedIdentity, pinnedStage })); });
    });
}
export const spawnCapturedProcess = defaultSpawnProcess;

function processCapture({ argv, cwd, startedUtc, finishedUtc, startedMonotonicMs, finishedMonotonicMs, exitCode, signal, stdoutPath, stderrPath }) {
    const stdout = fs.readFileSync(stdoutPath);
    const stderr = fs.readFileSync(stderrPath);
    return {
        argv, cwd, startedUtc, finishedUtc, startedMonotonicMs, finishedMonotonicMs, exitCode, signal,
        stdoutPath, stdoutBytes: stdout.length, stdoutSha256: sha256Bytes(stdout),
        stderrPath, stderrBytes: stderr.length, stderrSha256: sha256Bytes(stderr),
        stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
    };
}

async function capture(deps, options) {
    const startedUtc = deps.utcNow();
    const startedMonotonicMs = deps.monotonicNow();
    const result = await deps.spawnProcess(options);
    const finishedMonotonicMs = deps.monotonicNow();
    const finishedUtc = deps.utcNow();
    return processCapture({ ...options, ...result, startedUtc, finishedUtc, startedMonotonicMs, finishedMonotonicMs });
}

function publicCapture(value) {
    const { stdout, stderr, pinnedIdentity: _pinnedIdentity, pinnedStage: _pinnedStage, ...captureRecord } = value;
    return captureRecord;
}

export function revalidateAcceptedTree({ acceptedDir }) {
    const manifestPath = path.join(acceptedDir, 'artifact-manifest.json');
    const eventsPath = path.join(acceptedDir, 'runner-events.jsonl');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const eventText = fs.readFileSync(eventsPath, 'utf8');
    if (!eventText.endsWith('\n')) throw new Error('operation.events.termination');
    const events = eventText.slice(0, -1).split('\n').map(JSON.parse);
    let previous = '0'.repeat(64);
    if (events.length !== 518 || events.some((event, index) => {
        const { eventSha256, ...payload } = event;
        const invalid = event.seq !== index + 1 || event.previousEventSha256 !== previous || eventSha256 !== sha256Bytes(canonicalJson(payload));
        previous = eventSha256;
        return invalid;
    })) throw new Error('operation.events');
    const { manifestPayloadSha256, ...manifestPayload } = manifest;
    const actualFiles = [];
    const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en')).forEach((entry) => {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile() && absolute !== manifestPath) actualFiles.push(path.relative(acceptedDir, absolute).split(path.sep).join('/'));
        else if (!entry.isFile()) throw new Error('operation.manifest.regular');
    });
    walk(acceptedDir);
    if (manifestPayloadSha256 !== sha256Bytes(canonicalJson(manifestPayload)) || !Array.isArray(manifest.files) || canonicalJson(actualFiles) !== canonicalJson(manifest.files.map(({ path: relative }) => relative)) || manifest.files.some((entry) => {
        const file = path.join(acceptedDir, ...entry.path.split('/'));
        return entry.path === 'artifact-manifest.json' || !fs.existsSync(file) || fs.statSync(file).size !== entry.bytes || sha256File(file) !== entry.sha256;
    })) throw new Error('operation.manifest');
    const observations = JSON.parse(fs.readFileSync(path.join(acceptedDir, 'observations.json'), 'utf8'));
    const screenshotBindings = observations.flatMap((record) => record.screenshots.map((shot) => ({ case: shot.caseLabel, stage: shot.stage, path: shot.relativePath, pngSha256: shot.sha256, oracleSha256: shot.oracleSnapshotSha256, captureStartUtc: shot.captureStartedUtc, captureEndUtc: shot.captureFinishedUtc })));
    if (screenshotBindings.length !== 18 || screenshotBindings.some((binding) => !fs.existsSync(path.join(acceptedDir, ...binding.path.split('/'))) || sha256File(path.join(acceptedDir, ...binding.path.split('/'))) !== binding.pngSha256)) throw new Error('operation.screenshots');
    const control = Object.fromEntries(['pre', 'mid', 'post'].map((phase) => {
        const capturePath = `control-plane/${phase}.command.json`;
        const captureFile = path.join(acceptedDir, ...capturePath.split('/'));
        const capture = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
        const rows = JSON.parse(fs.readFileSync(path.join(acceptedDir, ...capture.stdoutPath.split('/')), 'utf8'));
        return [phase, { capturePath, captureSha256: sha256File(captureFile), deploymentId: rows[0].Id }];
    }));
    const initialPath = 'file-probes/initial-10.json', finalAliasPath = 'file-probes/final-alias-5.json';
    const initialProbe = JSON.parse(fs.readFileSync(path.join(acceptedDir, ...initialPath.split('/')), 'utf8'));
    const finalAliasProbe = JSON.parse(fs.readFileSync(path.join(acceptedDir, ...finalAliasPath.split('/')), 'utf8'));
    return {
        eventCount: events.length,
        screenshotBindings,
        accepted: {
            realpath: fs.realpathSync(acceptedDir), manifestPath, manifestSha256: sha256File(manifestPath),
            treeDigest: sha256Bytes(canonicalJson({ files: manifest.files, manifestSha256: sha256File(manifestPath) })),
            publishedUtc: fs.statSync(manifestPath).mtime.toISOString(),
            eventsPath, eventsSha256: sha256File(eventsPath), eventCount: events.length, finalEventSha256: events.at(-1).eventSha256,
        },
        cloudflareReads: control,
        fileProbes: { initialPath, initialSha256: sha256File(path.join(acceptedDir, ...initialPath.split('/'))), initialPassed: initialProbe.passed, initialTotal: initialProbe.total, finalAliasPath, finalAliasSha256: sha256File(path.join(acceptedDir, ...finalAliasPath.split('/'))), finalAliasPassed: finalAliasProbe.passed, finalAliasTotal: finalAliasProbe.total },
    };
}

export async function authenticateTask2Accepted({ acceptedDir, operationReceipt, auditAccepted }) {
    const manifestPath = path.join(acceptedDir, 'artifact-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const manifestSha256 = sha256File(manifestPath);
    if (operationReceipt?.accepted?.manifestSha256 !== manifestSha256 || operationReceipt.accepted.treeDigest !== sha256Bytes(canonicalJson({ files: manifest.files, manifestSha256 }))) throw new Error('task2.accepted.binding');
    const observationsEntry = manifest.files.find((entry) => entry.path === 'observations.json');
    const observationsPath = path.join(acceptedDir, 'observations.json');
    if (!observationsEntry || observationsEntry.bytes !== fs.statSync(observationsPath).size || observationsEntry.sha256 !== sha256File(observationsPath)) throw new Error('task2.accepted.observations');
    validateTask2FairPingObservations(JSON.parse(fs.readFileSync(observationsPath, 'utf8')));
    return auditAccepted();
}

export async function runOperationFromArgv(argv, overrides = {}) {
    const configPath = parseOperationArgv(argv);
    const config = validateOperationConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    assertOperationOutputsAbsent(config);
    const validateRunnerPolicy = overrides.validateRunnerPolicy ?? validateRunnerSourcePolicy;
    validateRunnerPolicy(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-public-smoke-v2.mjs'), 'utf8'));
    validateRunnerPolicy(fs.readFileSync(path.join(config.sourceSnapshotDir, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8'));
    (overrides.validatePreflightSeal ?? validatePreflightSeal)(config);
    const deps = {
        monotonicNow: () => performance.now(), utcNow: () => new Date().toISOString(), spawnProcess: defaultSpawnProcess,
        revalidateAccepted: revalidateAcceptedTree, validateReceipt: validateOperationReceipt,
        authenticateAccepted: (receipt) => authenticateTask2Accepted({ acceptedDir: config.acceptedDir, operationReceipt: receipt, auditAccepted: () => auditAcceptedRun({ configPath, operationReceipt: receipt }) }), ...overrides,
    };
    const operationStartedMonotonicMs = deps.monotonicNow();
    const plan = processArgv(config, configPath);
    const verifierStdout = path.join(config.releaseRoot, 'campaign-verifier.stdout.bin');
    const verifierStderr = path.join(config.releaseRoot, 'campaign-verifier.stderr.bin');
    await fs.promises.mkdir(config.releaseRoot, { recursive: true });
    const verifier = await capture(deps, { argv: plan.verifier, cwd: config.authorityProjectRoot, stdoutPath: verifierStdout, stderrPath: verifierStderr, timeoutMs: remainingOperationBudget(operationStartedMonotonicMs, deps.monotonicNow()) });
    requireProcessSuccess(verifier, 'operation.campaignVerifier', 'R10_CAMPAIGN_GATE=VERIFIED\n');
    const authority = overrides.phaseAuthority ?? (async (phase, stageDir) => {
        validateExecutionSeal(config, stageDir);
        const timeoutMs = remainingOperationBudget(operationStartedMonotonicMs, deps.monotonicNow());
        if (phase === 'initial') return { initialProbe: await collectInitialProbe({ config, stageDir, timeoutMs }), controlPlane: await collectControlPlane('pre', { config, stageDir, timeoutMs }) };
        if (phase === 'mid') return { controlPlane: await collectControlPlane('mid', { config, stageDir, timeoutMs }) };
        return { controlPlane: await collectControlPlane('post', { config, stageDir, timeoutMs }), finalProbe: await collectFinalProbe({ config, stageDir, timeoutMs }) };
    });
    const worker = await capture(deps, { argv: plan.worker, cwd: config.authorityProjectRoot, stdoutPath: config.workerStdoutPath, stderrPath: config.workerStderrPath, phaseAuthority: authority, releaseRoot: config.releaseRoot, failureRoot: config.failureRoot, acceptedDir: config.acceptedDir, releaseId: config.releaseId, timeoutMs: remainingOperationBudget(operationStartedMonotonicMs, deps.monotonicNow()) });
    requireProcessSuccess(worker, 'operation.worker');
    enforceStrictDeadline(worker.finishedMonotonicMs - operationStartedMonotonicMs, 900000, 'operation.deadline');
    return await runPostWorkerGates({
        revalidateAccepted: async () => {
            const validated = await deps.revalidateAccepted({ acceptedDir: config.acceptedDir, config, configPath, timeoutMs: remainingOperationBudget(operationStartedMonotonicMs, deps.monotonicNow()) });
            if (validated.eventCount !== 518 || validated.screenshotBindings.length !== 18) throw new Error('operation.accepted');
            return validated;
        },
        createReceipt: (validated) => ({
            schemaVersion: 1, releaseId: config.releaseId, createdUtc: deps.utcNow(), status: 'VERIFIED',
            configPath, configSha256: sha256File(configPath), orchestratorPath: fileURLToPath(import.meta.url), orchestratorSha256: sha256File(fileURLToPath(import.meta.url)),
            campaignVerifier: { ...publicCapture(verifier), gateLine: 'R10_CAMPAIGN_GATE=VERIFIED', verifierPath: plan.verifierPath, verifierSha256: sha256File(plan.verifierPath) },
            worker: publicCapture(worker), accepted: { ...validated.accepted, eventCount: validated.eventCount }, screenshotBindings: validated.screenshotBindings,
            cloudflareReads: validated.cloudflareReads, fileProbes: validated.fileProbes,
        }),
        validateReceipt: deps.validateReceipt,
        authenticateAccepted: (receipt) => deps.authenticateAccepted(receipt, { timeoutMs: remainingOperationBudget(operationStartedMonotonicMs, deps.monotonicNow()) }),
        publishReceipt: (receipt) => publishOperationReceiptAtomically({ receiptPath: config.operationReceiptPath, bytes: Buffer.from(`${canonicalJson(receipt)}\n`), operationStartedMonotonicMs, monotonicNow: deps.monotonicNow }),
        recoverAccepted: () => recoverAcceptedPublication({ acceptedDir: config.acceptedDir, failureRoot: config.failureRoot, releaseId: config.releaseId, pinnedIdentity: worker.pinnedIdentity }),
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runOperationFromArgv(process.argv.slice(2)).catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
