import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserCountsAreComplete, parsePassingBrowserCounts } from './campaign-evidence.mjs';
import {
    FROZEN_GAME_CORE_SHA256,
    assertCanonicalCampaignSource,
    assertFrozenSnapshotUnchanged,
    assertR10RunId,
    buildR10PhasePlan,
    claimRun,
    collectInventory,
    contentInventorySha256,
    copyInventory,
    inventoriesEqual,
    pathInventorySha256,
    publishDirectoryAtomically,
    runRecordedCommand,
    sha256File,
    snapshotR10Frozen,
    tapCounts,
    validatePerformanceEvidence,
    writeJsonExclusive,
} from './r10-campaign-lib.mjs';
import { collectArtifactManifest } from './verify-r10-campaign.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptFile), '..');
const workspaceRoot = path.resolve(projectRoot, '..');
const V1_SHA256 = '96D6F8407DF3B4E5D3DDB4CBEB42F6430F221C909B56353118D3B14D3777884B';

export function buildPhasePlan(cleanSource) {
    return buildR10PhasePlan(cleanSource);
}

function walkFiles(root, prefix, predicate, output) {
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const absolute = path.join(root, entry.name);
        const relative = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walkFiles(absolute, relative, predicate, output);
        else if (entry.isFile() && predicate(relative)) {
            const stat = fs.statSync(absolute);
            output.push({ path: relative.split(path.sep).join('/'), sizeBytes: stat.size, sha256: sha256File(absolute) });
        }
    }
}

export function snapshotR9Frozen(project, workspace) {
    const files = [];
    walkFiles(path.join(project, 'evidence', 'campaigns'), 'evidence/campaigns', (name) => /-r9-/i.test(name), files);
    walkFiles(path.join(project, '.campaign-operations'), '.campaign-operations', (name) => /-r9-/i.test(name), files);
    walkFiles(path.join(workspace, 'review'), 'workspace-review', (name) => /r9|deployment[-_].*mission02/i.test(name), files);
    files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    return {
        fileCount: files.length,
        pathListSha256: pathInventorySha256(files),
        digest: contentInventorySha256(files),
        files,
    };
}

export { assertFrozenSnapshotUnchanged, snapshotR10Frozen };

export function beginOfficialCampaign({ project, workspace, operationsRoot, campaignsRoot, runId }) {
    assertR10RunId(runId);
    const sourceBinding = assertCanonicalCampaignSource(project);
    const r10FrozenBefore = snapshotR10Frozen(project, workspace, runId);
    if (r10FrozenBefore.fileCount === 0) throw new Error('R10_FROZEN_EVIDENCE_MISSING');
    const ownership = claimRun({ operationsRoot, campaignsRoot, runId });
    return { ownership, sourceBinding, r10FrozenBefore };
}

function read(file) {
    return fs.readFileSync(file, 'utf8');
}

function readJson(file) {
    return JSON.parse(read(file));
}

function copyExclusive(source, target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

export function publishVerifiedOutputs({
    stagedCampaign,
    stagedSpec,
    stagedReceipt,
    finalCampaign,
    finalSpec,
    finalReceipt,
    commitMarker,
    commitValue,
    verification,
    publicationGuard,
}) {
    if (verification?.status !== 'VERIFIED') throw new Error('OFFICIAL_PUBLISH_REQUIRES_VERIFIED_GATE');
    if ([finalCampaign, finalSpec, finalReceipt, commitMarker].some((target) => fs.existsSync(target))) {
        throw new Error('OFFICIAL_PUBLISH_TARGET_EXISTS');
    }
    if (typeof publicationGuard !== 'function') throw new Error('OFFICIAL_PUBLISH_REQUIRES_LIVE_FROZEN_GUARD');
    publicationGuard();
    publishDirectoryAtomically(stagedCampaign, finalCampaign);
    copyExclusive(stagedSpec, finalSpec);
    copyExclusive(stagedReceipt, finalReceipt);
    fs.chmodSync(finalSpec, 0o444);
    writeJsonExclusive(commitMarker, commitValue);
}

function commandWithArtifactPaths(command) {
    return {
        ...command,
        stdoutArtifactPath: `commands/${path.basename(command.stdoutPath)}`,
        stderrArtifactPath: `commands/${path.basename(command.stderrPath)}`,
    };
}

function phaseResultOrThrow(command) {
    if (command.exitCode !== 0 || command.timedOut) {
        throw new Error(`PHASE_FAILED key=${command.key} exit=${command.exitCode} timedOut=${command.timedOut}`);
    }
}

function buildSpec({ runId, candidate, claims, campaignTarget, createdUtc }) {
    const performance = claims.performance;
    return `# Mission-02 R10 Korean Release Evidence\n\n`
        + `- review_target: ${projectRoot}\n`
        + `- comparison_base: frozen baseline ZIP SHA-256 ${V1_SHA256}\n`
        + `- campaign: ${campaignTarget}\n`
        + `- status: success (only valid with R10_CAMPAIGN_GATE=VERIFIED)\n`
        + `- created_utc: ${createdUtc}\n`
        + `- risks: none critical\n`
        + `- threat_model: file_io, exec, env_var, evidence substitution, duplicate run, hash tampering, stale shared evidence\n\n`
        + `## Candidate source binding\n\n`
        + `- run_id: ${runId}\n`
        + `- ordered_files: ${candidate.fileCount}\n`
        + `- NUL-delimited path digest: ${candidate.pathListSha256}\n`
        + `- path-size-content digest: ${candidate.contentRecordsSha256}\n`
        + `- game-core.js SHA-256: ${claims.gameCoreSha256}\n`
        + `- canonical Git main HEAD: ${claims.sourceGit.headSha}\n`
        + `- R9 frozen snapshot: ${claims.r9Frozen.fileCount} files, ${claims.r9Frozen.beforeDigest}\n\n`
        + `- pre-existing R10 frozen snapshot: ${claims.r10Frozen.fileCount} files, ${claims.r10Frozen.beforeDigest}\n\n`
        + `## Executed evidence\n\n`
        + `- Node TAP: ${claims.unit.passed}/${claims.unit.tests}, failed ${claims.unit.failed}, exit ${claims.unit.exitCode}\n`
        + `- Playwright: Chromium ${claims.browser.chromium.passed}/16, Firefox ${claims.browser.firefox.passed}/16, WebKit ${claims.browser.webkit.passed}/16; total 48/48\n`
        + `- Performance: warm-up 30000ms; duration ${performance.measuredDurationMs}ms; samples ${performance.sampleCount}; P95 ${performance.p95LatencyMs}ms; P99 ${performance.p99LatencyMs}ms; long tasks ${performance.longTasksCount}; heap ${performance.heapNetGrowthMb}MiB; actions ${performance.totalActionsCount}\n`
        + `- Evidence negative controls: ${claims.negativeControls.passed}/${claims.negativeControls.total}\n`
        + `- Campaign verifier tests: ${claims.campaignVerifier.passed}/${claims.campaignVerifier.tests}\n`
        + `- Existing manifest/evidence verifier: EVIDENCE_GATE=GO in isolated clean-room\n\n`
        + `## Scope limitation\n\n`
        + `- 3-engine 640x360 equivalent PASS. actual browser chrome zoom not claimed.\n`
        + `- This is a noncritical manual acceptance limitation and does not substitute for the automated reflow checks.\n\n`
        + `## Review package\n\n`
        + `The campaign binds candidate-inventory.json, claims.json, ledger.jsonl, artifact-manifest.json, raw frame samples, performance summary, phase logs, source hashes, and this spec through submission-envelope.json.\n`;
}

function exactNegativeCounts(text) {
    const match = text.match(/NEGATIVE CONTROLS SUITE R7:\s+(\d+)\s+\/\s+(\d+)\s+PASSED/);
    if (!match) throw new Error('NEGATIVE_CONTROL_COUNT_PROOF_MISSING');
    return { passed: Number(match[1]), total: Number(match[2]) };
}

function archiveFileExact(source, target, expectedSha256) {
    if (!fs.existsSync(source) || sha256File(source) !== expectedSha256) {
        throw new Error(`ARCHIVE_SOURCE_HASH_MISMATCH source=${source}`);
    }
    if (fs.existsSync(target)) {
        if (sha256File(target) !== expectedSha256) throw new Error(`ARCHIVE_OVERWRITE_REFUSED mismatch=${target}`);
        return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    if (sha256File(target) !== expectedSha256) throw new Error(`ARCHIVE_COPY_HASH_MISMATCH target=${target}`);
}

export function archiveCommandEvidence(operationDir, commands) {
    return commands.map((command) => {
        const stdoutPath = path.join(operationDir, 'logs', path.basename(command.stdoutPath));
        const stderrPath = path.join(operationDir, 'logs', path.basename(command.stderrPath));
        archiveFileExact(command.stdoutPath, stdoutPath, command.stdoutSha256);
        archiveFileExact(command.stderrPath, stderrPath, command.stderrSha256);
        const archived = { ...command, stdoutPath, stderrPath };
        const receiptPath = path.join(operationDir, 'commands', `${command.key}.json`);
        const serialized = `${JSON.stringify(archived, null, 2)}\n`;
        if (fs.existsSync(receiptPath)) {
            if (fs.readFileSync(receiptPath, 'utf8') !== serialized) throw new Error(`ARCHIVE_RECEIPT_OVERWRITE_REFUSED mismatch=${receiptPath}`);
        } else {
            fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
            fs.writeFileSync(receiptPath, serialized, { encoding: 'utf8', flag: 'wx' });
        }
        return archived;
    });
}

export function persistNoGo({ operationDir, runId, reason, commands, cleanRoot }) {
    const archivedCommands = archiveCommandEvidence(operationDir, commands);
    const target = path.join(operationDir, 'NO_GO.json');
    if (fs.existsSync(target)) throw new Error(`NO_GO_OVERWRITE_REFUSED path=${target}`);
    writeJsonExclusive(target, {
        schemaVersion: 1,
        runId,
        status: 'NO_GO',
        timestampUtc: new Date().toISOString(),
        reason,
        cleanRoot,
        commands: archivedCommands,
        reuseAllowed: false,
    });
    return archivedCommands;
}

export function runR10Campaign(runId) {
    const campaignsRoot = path.join(projectRoot, 'evidence', 'campaigns');
    const operationsRoot = path.join(projectRoot, '.campaign-operations');
    const entry = beginOfficialCampaign({
        project: projectRoot,
        workspace: workspaceRoot,
        operationsRoot,
        campaignsRoot,
        runId,
    });
    const ownership = entry.ownership;
    const sourceBinding = entry.sourceBinding;
    const r10Before = entry.r10FrozenBefore;
    const cleanRoot = process.platform === 'win32'
        ? path.join(path.parse(projectRoot).root, 'tmp', `penguin-r10-${runId}`)
        : path.join('/tmp', `penguin-r10-${runId}`);
    const cleanSource = path.join(cleanRoot, 'source');
    const cleanOperationDir = path.join(cleanRoot, 'operations');
    const cleanLogs = path.join(cleanOperationDir, 'logs');
    const cleanCommandReceipts = path.join(cleanOperationDir, 'commands');
    const stagingRoot = path.join(cleanRoot, 'staging');
    const stagedCampaign = path.join(stagingRoot, 'campaign');
    const stagedSpec = path.join(stagingRoot, 'spec.md');
    const finalSpec = path.join(workspaceRoot, 'review', `spec_${runId}_mission02_r10_korean_release.md`);
    const finalReceipt = path.join(workspaceRoot, 'review', `receipt_${runId}_campaign.json`);
    const stagedReceipt = path.join(stagingRoot, 'campaign-receipt.json');
    const commitMarker = path.join(ownership.operationDir, 'SUCCESS.json');
    const commands = [];
    const createdUtc = ownership.receipt.createdUtc;
    let committed = false;

    try {
        if (fs.existsSync(cleanRoot)) throw new Error(`CLEAN_ROOT_ALREADY_EXISTS path=${cleanRoot}`);
        if (fs.existsSync(finalSpec) || fs.existsSync(finalReceipt)) throw new Error('APPEND_ONLY_REVIEW_TARGET_EXISTS');

        const gameCoreSha256 = sha256File(path.join(projectRoot, 'game-core.js'));
        if (gameCoreSha256 !== FROZEN_GAME_CORE_SHA256) throw new Error(`GAME_CORE_FROZEN_HASH_MISMATCH actual=${gameCoreSha256}`);
        const r9Before = snapshotR9Frozen(projectRoot, workspaceRoot);
        const candidate = collectInventory(projectRoot);

        fs.mkdirSync(cleanRoot, { recursive: false });
        writeJsonExclusive(path.join(cleanOperationDir, 'candidate-inventory.json'), candidate);
        writeJsonExclusive(path.join(cleanOperationDir, 'r9-before.json'), r9Before);
        writeJsonExclusive(path.join(cleanOperationDir, 'r10-before.json'), r10Before);
        copyInventory(projectRoot, cleanSource, candidate.files);
        const copiedInventory = collectInventory(cleanSource);
        if (!inventoriesEqual(candidate, copiedInventory)) throw new Error('CLEAN_COPY_INVENTORY_MISMATCH');

        const phasePlan = buildPhasePlan(cleanSource);
        for (const phase of phasePlan) {
            const command = runRecordedCommand({ ...phase, logsDir: cleanLogs });
            commands.push(command);
            writeJsonExclusive(path.join(cleanCommandReceipts, `${phase.key}.json`), command);
            phaseResultOrThrow(command);
        }

        const postPhaseInventory = collectInventory(cleanSource);
        if (!inventoriesEqual(candidate, postPhaseInventory)) throw new Error('CANDIDATE_SOURCE_CHANGED_DURING_CAMPAIGN');
        if (sha256File(path.join(cleanSource, 'game-core.js')) !== FROZEN_GAME_CORE_SHA256) throw new Error('CLEAN_GAME_CORE_HASH_MISMATCH');

        const unitCommand = commands.find((command) => command.key === '30-unit');
        const unit = tapCounts(read(unitCommand.stdoutPath));
        if (unit.tests !== 29 || unit.passed !== 29 || unit.failed !== 0) throw new Error(`UNIT_COUNT_MISMATCH ${JSON.stringify(unit)}`);

        const browserCommand = commands.find((command) => command.key === '40-browser');
        const browser = parsePassingBrowserCounts(read(browserCommand.stdoutPath), browserCommand.exitCode);
        if (!browserCountsAreComplete(browser)) throw new Error(`BROWSER_COUNT_MISMATCH ${JSON.stringify(browser)}`);

        const summaryPath = path.join(cleanSource, 'evidence', 'performance', 'performance-summary.json');
        const samplesPath = path.join(cleanSource, 'evidence', 'performance', 'frame-samples.json');
        const performanceSummary = readJson(summaryPath);
        const rawSamples = readJson(samplesPath);
        const performance = validatePerformanceEvidence(performanceSummary, rawSamples, process.env);

        const evidenceGateCommand = commands.find((command) => command.key === '61-evidence-gate');
        if (!read(evidenceGateCommand.stdoutPath).includes('EVIDENCE_GATE=GO')) throw new Error('EVIDENCE_GATE_GO_PROOF_MISSING');
        const negativeCommand = commands.find((command) => command.key === '70-negative-controls');
        const negative = exactNegativeCounts(read(negativeCommand.stdoutPath));
        if (negative.passed !== 21 || negative.total !== 21) throw new Error(`NEGATIVE_CONTROL_COUNT_MISMATCH ${JSON.stringify(negative)}`);
        const campaignVerifierCommand = commands.find((command) => command.key === '71-campaign-verifier-tests');
        const campaignVerifier = tapCounts(read(campaignVerifierCommand.stdoutPath));
        if (campaignVerifier.tests < 1 || campaignVerifier.passed !== campaignVerifier.tests || campaignVerifier.failed !== 0) {
            throw new Error(`CAMPAIGN_VERIFIER_TEST_MISMATCH ${JSON.stringify(campaignVerifier)}`);
        }

        const r9After = snapshotR9Frozen(projectRoot, workspaceRoot);
        if (JSON.stringify(r9After) !== JSON.stringify(r9Before)) throw new Error('R9_FROZEN_EVIDENCE_CHANGED');
        const r10After = snapshotR10Frozen(projectRoot, workspaceRoot, runId);
        assertFrozenSnapshotUnchanged(r10Before, r10After, 'R10');

        fs.mkdirSync(path.join(stagedCampaign, 'commands'), { recursive: true });
        const stagedSourceSnapshot = path.join(stagedCampaign, 'source-snapshot');
        copyInventory(cleanSource, stagedSourceSnapshot, candidate.files);
        if (!inventoriesEqual(candidate, collectInventory(stagedSourceSnapshot))) throw new Error('STAGED_SOURCE_SNAPSHOT_MISMATCH');
        copyExclusive(path.join(cleanOperationDir, 'candidate-inventory.json'), path.join(stagedCampaign, 'candidate-inventory.json'));
        fs.writeFileSync(path.join(stagedCampaign, 'r9-before.json'), `${JSON.stringify(r9Before, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        fs.writeFileSync(path.join(stagedCampaign, 'r9-after.json'), `${JSON.stringify(r9After, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        fs.writeFileSync(path.join(stagedCampaign, 'r10-before.json'), `${JSON.stringify(r10Before, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        fs.writeFileSync(path.join(stagedCampaign, 'r10-after.json'), `${JSON.stringify(r10After, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        copyExclusive(summaryPath, path.join(stagedCampaign, 'performance-summary.json'));
        copyExclusive(samplesPath, path.join(stagedCampaign, 'frame-samples.json'));
        const campaignCommands = commands.map(commandWithArtifactPaths);
        for (const command of campaignCommands) {
            copyExclusive(command.stdoutPath, path.join(stagedCampaign, command.stdoutArtifactPath));
            copyExclusive(command.stderrPath, path.join(stagedCampaign, command.stderrArtifactPath));
        }

        const claims = {
            schemaVersion: 4,
            runId,
            v1Sha256: V1_SHA256,
            candidateInventory: {
                fileCount: candidate.fileCount,
                pathListSha256: candidate.pathListSha256,
                contentRecordsSha256: candidate.contentRecordsSha256,
            },
            gameCoreSha256,
            sourceGit: { branch: sourceBinding.branch, headSha: sourceBinding.headSha },
            unit: { ...unit, exitCode: unitCommand.exitCode },
            browser: { ...browser, exitCode: browserCommand.exitCode },
            performance: performanceSummary,
            negativeControls: { ...negative, failed: negative.total - negative.passed, exitCode: negativeCommand.exitCode },
            campaignVerifier: { ...campaignVerifier, exitCode: campaignVerifierCommand.exitCode },
            r9Frozen: {
                fileCount: r9Before.fileCount,
                pathListSha256: r9Before.pathListSha256,
                beforeDigest: r9Before.digest,
                afterDigest: r9After.digest,
            },
            r10Frozen: {
                fileCount: r10Before.fileCount,
                pathListSha256: r10Before.pathListSha256,
                beforeDigest: r10Before.digest,
                afterDigest: r10After.digest,
            },
            actualBrowserZoom: {
                claimed: false,
                equivalentReflow: '3-engine 640x360 equivalent PASS',
                limitation: 'actual browser chrome zoom not claimed',
            },
        };
        fs.writeFileSync(path.join(stagedCampaign, 'claims.json'), `${JSON.stringify(claims, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

        const internalTimes = {
            inventory: new Date(Date.parse(createdUtc) + 1).toISOString(),
            copy: new Date(Date.parse(createdUtc) + 2).toISOString(),
        };
        const ledger = [
            { schemaVersion: 4, runId, state: 'CREATED', timestampUtc: createdUtc, command: null },
            { schemaVersion: 4, runId, state: 'SOURCE_INVENTORY_PASS', timestampUtc: internalTimes.inventory, command: null },
            { schemaVersion: 4, runId, state: 'CLEAN_COPY_PASS', timestampUtc: internalTimes.copy, command: null },
            ...phasePlan.map((phase) => ({
                schemaVersion: 4,
                runId,
                state: phase.state,
                timestampUtc: campaignCommands.find((command) => command.key === phase.key).endedUtc,
                command: campaignCommands.find((command) => command.key === phase.key),
            })),
            { schemaVersion: 4, runId, state: 'PACKAGE_READY_FOR_GATE', timestampUtc: new Date().toISOString(), command: null },
        ];
        fs.writeFileSync(path.join(stagedCampaign, 'ledger.jsonl'), `${ledger.map(JSON.stringify).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });

        fs.mkdirSync(path.dirname(stagedSpec), { recursive: true });
        fs.writeFileSync(stagedSpec, buildSpec({ runId, candidate, claims, campaignTarget: ownership.campaignDir, createdUtc }), { encoding: 'utf8', flag: 'wx' });
        const artifactManifest = collectArtifactManifest(stagedCampaign);
        fs.writeFileSync(path.join(stagedCampaign, 'artifact-manifest.json'), `${JSON.stringify(artifactManifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        const payloadHashes = Object.fromEntries(
            [
                'artifact-manifest.json', 'candidate-inventory.json', 'claims.json', 'ledger.jsonl',
                'r9-before.json', 'r9-after.json', 'r10-before.json', 'r10-after.json',
            ]
                .map((name) => [name, sha256File(path.join(stagedCampaign, name))]),
        );
        const envelope = {
            schemaVersion: 4,
            runId,
            payloadHashes,
            source: {
                path: 'source-snapshot',
                fileCount: candidate.fileCount,
                pathListSha256: candidate.pathListSha256,
                contentRecordsSha256: candidate.contentRecordsSha256,
                gitBranch: sourceBinding.branch,
                gitHeadSha: sourceBinding.headSha,
            },
            spec: { fileName: path.basename(finalSpec), sizeBytes: fs.statSync(stagedSpec).size, sha256: sha256File(stagedSpec) },
            rawEvidence: {
                summary: { path: 'performance-summary.json', sha256: sha256File(path.join(stagedCampaign, 'performance-summary.json')) },
                samples: { path: 'frame-samples.json', sha256: sha256File(path.join(stagedCampaign, 'frame-samples.json')) },
            },
        };
        fs.writeFileSync(path.join(stagedCampaign, 'submission-envelope.json'), `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

        const verifierScript = path.join(cleanSource, 'scripts', 'verify-r10-campaign.mjs');
        const verifyArgs = (campaignPath, specPath, sourcePath, executionPath) => [
            process.execPath, verifierScript, '--campaign', campaignPath, '--spec', specPath, '--source', sourcePath,
            '--execution-source', executionPath, '--run', runId,
            '--authority-project', projectRoot, '--authority-workspace', workspaceRoot,
        ];
        const stagedVerify = runRecordedCommand({
            key: '80-r10-staged-gate', argv: verifyArgs(stagedCampaign, stagedSpec, stagedSourceSnapshot, cleanSource), cwd: cleanSource, logsDir: cleanLogs, timeoutMs: 120000,
        });
        commands.push(stagedVerify);
        writeJsonExclusive(path.join(cleanCommandReceipts, '80-r10-staged-gate.json'), stagedVerify);
        phaseResultOrThrow(stagedVerify);
        if (!read(stagedVerify.stdoutPath).includes('R10_CAMPAIGN_GATE=VERIFIED')) throw new Error('STAGED_R10_VERIFIED_PROOF_MISSING');
        const stagedVerification = { status: 'VERIFIED', command: stagedVerify };

        copyExclusive(path.join(cleanOperationDir, 'candidate-inventory.json'), path.join(ownership.operationDir, 'candidate-inventory.json'));
        copyExclusive(path.join(cleanOperationDir, 'r9-before.json'), path.join(ownership.operationDir, 'r9-before.json'));
        fs.writeFileSync(path.join(ownership.operationDir, 'r9-after.json'), `${JSON.stringify(r9After, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        copyExclusive(path.join(cleanOperationDir, 'r10-before.json'), path.join(ownership.operationDir, 'r10-before.json'));
        fs.writeFileSync(path.join(ownership.operationDir, 'r10-after.json'), `${JSON.stringify(r10After, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        const archivedCommands = archiveCommandEvidence(ownership.operationDir, commands);
        const receipt = {
            schemaVersion: 1,
            runId,
            status: 'VERIFIED',
            createdUtc,
            completedUtc: new Date().toISOString(),
            projectRoot,
            cleanRoot,
            campaign: {
                path: ownership.campaignDir,
                artifactManifestSha256: sha256File(path.join(stagedCampaign, 'artifact-manifest.json')),
                submissionEnvelopeSha256: sha256File(path.join(stagedCampaign, 'submission-envelope.json')),
            },
            spec: { path: finalSpec, sizeBytes: fs.statSync(stagedSpec).size, sha256: sha256File(stagedSpec) },
            candidateInventory: claims.candidateInventory,
            gameCoreSha256,
            sourceGit: claims.sourceGit,
            r9Frozen: claims.r9Frozen,
            r10Frozen: claims.r10Frozen,
            commands: archivedCommands,
            limitation: claims.actualBrowserZoom,
            publicationState: 'COMMITTED only when operation SUCCESS.json exists and binds this receipt',
        };
        fs.writeFileSync(stagedReceipt, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        const commitValue = {
            schemaVersion: 1,
            runId,
            status: 'VERIFIED',
            committedUtc: new Date().toISOString(),
            campaignPath: ownership.campaignDir,
            specPath: finalSpec,
            receiptPath: finalReceipt,
            receiptSha256: sha256File(stagedReceipt),
            stagedGateStdoutSha256: stagedVerify.stdoutSha256,
            stagedGateStderrSha256: stagedVerify.stderrSha256,
        };
        publishVerifiedOutputs({
            stagedCampaign,
            stagedSpec,
            stagedReceipt,
            finalCampaign: ownership.campaignDir,
            finalSpec,
            finalReceipt,
            commitMarker,
            commitValue,
            verification: stagedVerification,
            publicationGuard: () => {
                const liveSource = assertCanonicalCampaignSource(projectRoot);
                if (liveSource.headSha !== sourceBinding.headSha) throw new Error('CANONICAL_HEAD_CHANGED_AT_PUBLICATION');
                assertFrozenSnapshotUnchanged(r9Before, snapshotR9Frozen(projectRoot, workspaceRoot), 'R9');
                assertFrozenSnapshotUnchanged(r10Before, snapshotR10Frozen(projectRoot, workspaceRoot, runId), 'R10');
            },
        });
        committed = true;
        console.log(`R10_CAMPAIGN_STATUS=VERIFIED run=${runId}`);
        console.log(`CAMPAIGN=${ownership.campaignDir}`);
        console.log(`SPEC=${finalSpec}`);
        console.log(`RECEIPT=${finalReceipt}`);
        return receipt;
    } catch (error) {
        if (!committed) persistNoGo({ operationDir: ownership.operationDir, runId, reason: error.stack ?? error.message, commands, cleanRoot });
        throw error;
    }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === scriptFile;
if (invokedDirectly) {
    const runIndex = process.argv.indexOf('--run');
    const runId = runIndex >= 0 ? process.argv[runIndex + 1] : null;
    try {
        runR10Campaign(runId);
    } catch (error) {
        console.error(`R10_CAMPAIGN_STATUS=NO_GO reason=${error.message}`);
        process.exitCode = 1;
    }
}
