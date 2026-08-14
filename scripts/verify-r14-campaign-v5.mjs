import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    sha256File,
    validateCampaignClaims,
    validateCampaignEnvelope,
    validateCampaignReceipt,
} from './public-smoke-v2-lib.mjs';

const PAYLOADS = Object.freeze([
    'artifact-manifest.json',
    'candidate-inventory.json',
    'claims.json',
    'ledger.jsonl',
    'r9-before.json',
    'r9-after.json',
    'r10-before.json',
    'r10-after.json',
]);

function fail(invariant, detail = '') {
    throw new Error(`${invariant}${detail ? `: ${detail}` : ''}`);
}

function readJson(file, invariant) {
    try {
        if (fs.lstatSync(file).isSymbolicLink()) fail(invariant, 'symlink');
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error) { fail(invariant, error.message); }
}

function exactKeys(value, expected, invariant) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(invariant, 'object');
    const actual = Object.keys(value).sort();
    const keys = [...expected].sort();
    if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail(invariant, `keys=${actual.join(',')}`);
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

function contained(root, candidate, invariant) {
    const base = path.resolve(root);
    const target = path.resolve(candidate);
    if (target === base || !target.startsWith(`${base}${path.sep}`)) fail(invariant);
    return target;
}

function verifyPayloadHashes(campaignDir, envelope) {
    for (const name of PAYLOADS) {
        const file = contained(campaignDir, path.join(campaignDir, name), `campaignV5.payload.${name}`);
        noSymlinkAncestors(file, `campaignV5.payload.${name}.symlink`);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile() || sha256File(file).toLowerCase() !== envelope.payloadHashes[name].toLowerCase()) fail(`campaignV5.payload.${name}`);
    }
}

function verifySourceInventory(sourceRoot, campaignDir, envelope, claims) {
    const candidate = readJson(path.join(campaignDir, 'candidate-inventory.json'), 'campaignV5.candidate');
    exactKeys(candidate, ['schemaVersion', 'algorithm', 'pathEncoding', 'fileCount', 'pathListSha256', 'contentRecordsSha256', 'files'], 'campaignV5.candidate');
    if (candidate.schemaVersion !== 1 || candidate.algorithm !== 'SHA-256' || candidate.pathEncoding !== 'UTF-8 NUL-terminated ordered path records' || !Array.isArray(candidate.files) || candidate.fileCount !== candidate.files.length || !/^[a-f0-9]{64}$/.test(candidate.pathListSha256) || !/^[a-f0-9]{64}$/.test(candidate.contentRecordsSha256)) fail('campaignV5.candidate');
    const sourceRelative = path.relative(campaignDir, sourceRoot).split(path.sep).join('/');
    if (envelope.source.path !== sourceRelative || envelope.source.fileCount !== candidate.fileCount || envelope.source.pathListSha256.toLowerCase() !== candidate.pathListSha256.toLowerCase() || envelope.source.contentRecordsSha256.toLowerCase() !== candidate.contentRecordsSha256.toLowerCase()) fail('campaignV5.source');
    if (claims.candidateInventory.fileCount !== candidate.fileCount || claims.candidateInventory.pathListSha256.toLowerCase() !== candidate.pathListSha256.toLowerCase() || claims.candidateInventory.contentRecordsSha256.toLowerCase() !== candidate.contentRecordsSha256.toLowerCase()) fail('campaignV5.claimsInventory');
    for (let index = 0; index < candidate.files.length; index += 1) {
        const entry = candidate.files[index];
        exactKeys(entry, ['path', 'sizeBytes', 'sha256'], 'campaignV5.candidate.file');
        if (typeof entry.path !== 'string' || entry.path.length === 0 || entry.path.startsWith('/') || entry.path.includes('\\') || (index > 0 && candidate.files[index - 1].path.localeCompare(entry.path, 'en') >= 0) || !Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail('campaignV5.candidate.file');
        const file = contained(sourceRoot, path.join(sourceRoot, ...entry.path.split('/')), 'campaignV5.sourceFile');
        noSymlinkAncestors(file, 'campaignV5.sourceFile.symlink');
        if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size !== entry.sizeBytes || sha256File(file).toLowerCase() !== entry.sha256.toLowerCase()) fail('campaignV5.sourceFile');
    }
    const pathListSha256 = sha256FileBytes(Buffer.from(candidate.files.map((entry) => `${entry.path}\0`).join(''), 'utf8'));
    const contentRecordsSha256 = sha256FileBytes(Buffer.from(candidate.files.map((entry) => `${entry.path}\0${entry.sizeBytes}\0${entry.sha256}\0`).join(''), 'utf8'));
    if (pathListSha256 !== candidate.pathListSha256 || contentRecordsSha256 !== candidate.contentRecordsSha256) fail('campaignV5.candidate.digest');
    return candidate;
}

function sha256FileBytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function parseCampaignVerifierArgv(argv) {
    const expected = ['--campaign', '--spec', '--source', '--execution-source', '--run', '--authority-project', '--authority-workspace'];
    if (argv.length !== expected.length * 2 || expected.some((key, index) => argv[index * 2] !== key)) fail('campaignV5.argv');
    const values = Object.fromEntries(expected.map((key, index) => [key.slice(2).replaceAll('-', ''), argv[index * 2 + 1]]));
    for (const key of ['campaign', 'spec', 'source', 'executionsource', 'authorityproject', 'authorityworkspace']) if (!path.isAbsolute(values[key])) fail('campaignV5.argv.path');
    return { ...values, campaign: path.resolve(values.campaign), spec: path.resolve(values.spec), source: path.resolve(values.source), executionsource: path.resolve(values.executionsource), authorityproject: path.resolve(values.authorityproject), authorityworkspace: path.resolve(values.authorityworkspace) };
}

export function verifyCampaignV5({ campaignDir, specPath, sourceRoot, expectedRunId, authorityProjectRoot, executionRoot }) {
    const campaign = path.resolve(campaignDir);
    const source = path.resolve(sourceRoot);
    if (!fs.existsSync(campaign) || !fs.statSync(campaign).isDirectory()) fail('campaignV5.directory');
    const claims = validateCampaignClaims(readJson(path.join(campaign, 'claims.json'), 'campaignV5.claims'));
    const envelope = validateCampaignEnvelope(readJson(path.join(campaign, 'submission-envelope.json'), 'campaignV5.envelope'));
    const receipt = validateCampaignReceipt(readJson(path.join(campaign, 'campaign-receipt.json'), 'campaignV5.receipt'));
    if (claims.runId !== expectedRunId || envelope.runId !== expectedRunId || receipt.runId !== expectedRunId) fail('campaignV5.runId');
    if (claims.sourceGit.branch !== 'main' || receipt.projectRoot !== path.resolve(authorityProjectRoot) || receipt.cleanRoot !== path.resolve(executionRoot)) fail('campaignV5.authorityRoots');
    if (path.resolve(receipt.spec.path) !== path.resolve(specPath) || receipt.spec.sizeBytes !== fs.statSync(specPath).size || receipt.spec.sha256.toLowerCase() !== sha256File(specPath).toLowerCase()) fail('campaignV5.spec');
    verifyPayloadHashes(campaign, envelope);
    const candidate = verifySourceInventory(source, campaign, envelope, claims);
    if (sha256File(path.join(source, 'game-core.js')).toLowerCase() !== claims.gameCoreSha256.toLowerCase()) fail('campaignV5.gameCore');
    return { status: 'VERIFIED', runId: expectedRunId, candidateFileCount: candidate.fileCount, sourceGitHead: claims.sourceGit.headSha };
}

async function main() {
    const values = parseCampaignVerifierArgv(process.argv.slice(2));
    const result = verifyCampaignV5({ campaignDir: values.campaign, specPath: values.spec, sourceRoot: values.source, expectedRunId: values.run, authorityProjectRoot: values.authorityproject, executionRoot: values.executionsource });
    process.stdout.write(`R10_CAMPAIGN_GATE=VERIFIED\n`);
    return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => { process.stderr.write(`R10_CAMPAIGN_GATE=NO_GO reason=${error.message}\n`); process.exitCode = 1; });
}
