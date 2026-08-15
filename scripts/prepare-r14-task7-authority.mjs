import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_KEYS = Object.freeze([
    'schemaVersion', 'projectName', 'accountId', 'sourceGitHead', 'sourceGitTree',
    'releaseId', 'campaignRunId', 'authorityRoot', 'nodeExePath', 'nodeExeSha256',
    'wranglerJsPath', 'wranglerJsSha256', 'operatorPath', 'operatorSha256',
    'campaignVerifierPath', 'campaignVerifierSha256', 'issuedUtc',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const GIT_ID = /^[0-9a-f]{40}$/;
const RELEASE_ID = /^\d{8}T\d{6}Z-r14-public-smoke-v2$/;
const CAMPAIGN_ID = /^\d{8}T\d{6}Z-r10-korean-release$/;
const APPROVED_SOURCE_HEAD = '349573e9a4fc3006db71c823a0571dfe9ec26847';
const APPROVED_SOURCE_TREE = 'e87817dd9d5a9b84427f70b998336a76031b6e70';
const FRESHNESS_TOLERANCE_MS = 300000;

function fail(invariant) {
    throw new Error(invariant);
}

function exactKeys(value, expected, invariant) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(invariant);
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) fail(invariant);
}

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function noSymlinkAncestors(target, invariant) {
    const resolved = path.resolve(target);
    const parsed = path.parse(resolved);
    let current = parsed.root;
    for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail(invariant);
    }
}

function validateFile(file, expectedSha256, invariant) {
    if (!path.isAbsolute(file) || !SHA256.test(expectedSha256)) fail(invariant);
    noSymlinkAncestors(file, invariant);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || sha256File(file) !== expectedSha256) fail(invariant);
}

function jsonBytes(value) {
    return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function timestampFromId(id) {
    const stamp = id.slice(0, 16);
    const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.000Z`;
    const instant = new Date(iso);
    if (Number.isNaN(instant.getTime()) || instant.toISOString() !== iso) fail('authority.config.identity');
    return instant;
}

function writeExclusive(file, bytes) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function validateConfig(config, now) {
    exactKeys(config, CONFIG_KEYS, 'authority.config');
    if (config.schemaVersion !== 1 || config.projectName !== 'penguin-exit-0') fail('authority.config.project');
    if (!ACCOUNT_ID.test(config.accountId) || !GIT_ID.test(config.sourceGitHead) || !GIT_ID.test(config.sourceGitTree) || config.sourceGitHead !== APPROVED_SOURCE_HEAD || config.sourceGitTree !== APPROVED_SOURCE_TREE) fail('authority.config.source');
    if (!RELEASE_ID.test(config.releaseId) || !CAMPAIGN_ID.test(config.campaignRunId)) fail('authority.config.identity');
    if (!path.isAbsolute(config.authorityRoot)) fail('authority.config.root');
    noSymlinkAncestors(config.authorityRoot, 'authority.config.root');
    if (!fs.statSync(config.authorityRoot).isDirectory() || fs.lstatSync(config.authorityRoot).isSymbolicLink()) fail('authority.config.root');
    const releaseInstant = timestampFromId(config.releaseId);
    const campaignInstant = timestampFromId(config.campaignRunId);
    const issuedInstant = new Date(config.issuedUtc);
    if (releaseInstant.getTime() !== campaignInstant.getTime() || Number.isNaN(issuedInstant.getTime()) || issuedInstant.toISOString() !== releaseInstant.toISOString()) fail('authority.config.identity');
    const nowInstant = now();
    if (!(nowInstant instanceof Date) || Number.isNaN(nowInstant.getTime()) || Math.abs(nowInstant.getTime() - releaseInstant.getTime()) > FRESHNESS_TOLERANCE_MS) fail('authority.config.freshness');
    validateFile(config.nodeExePath, config.nodeExeSha256, 'authority.config.node');
    validateFile(config.wranglerJsPath, config.wranglerJsSha256, 'authority.config.wrangler');
    validateFile(config.operatorPath, config.operatorSha256, 'authority.config.operator');
    validateFile(config.campaignVerifierPath, config.campaignVerifierSha256, 'authority.config.campaignVerifier');
}

export async function prepareAuthority(config, { now = () => new Date() } = {}) {
    validateConfig(config, now);
    const expectedManifest = {
        schemaVersion: 1,
        projectName: config.projectName,
        accountId: config.accountId,
        sourceGitHead: config.sourceGitHead,
        sourceGitTree: config.sourceGitTree,
        nodeExeSha256: config.nodeExeSha256,
        wranglerJsSha256: config.wranglerJsSha256,
        operatorSha256: config.operatorSha256,
        campaignVerifierSha256: config.campaignVerifierSha256,
        createdUtc: config.issuedUtc,
    };
    const manifestPath = path.join(config.authorityRoot, 'authority-manifest.json');
    let manifestBytes;
    if (fs.existsSync(manifestPath)) {
        const stat = fs.lstatSync(manifestPath);
        if (stat.isSymbolicLink() || !stat.isFile()) fail('authority.manifest');
        manifestBytes = fs.readFileSync(manifestPath);
        let manifest;
        try { manifest = JSON.parse(manifestBytes); } catch { fail('authority.manifest'); }
        exactKeys(manifest, Object.keys(expectedManifest), 'authority.manifest');
        for (const key of Object.keys(expectedManifest).filter((key) => key !== 'createdUtc')) {
            if (manifest[key] !== expectedManifest[key]) fail('authority.manifest.binding');
        }
        if (Number.isNaN(Date.parse(manifest.createdUtc))) fail('authority.manifest.createdUtc');
    } else {
        manifestBytes = jsonBytes(expectedManifest);
        writeExclusive(manifestPath, manifestBytes);
    }
    const authorityManifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex');
    const identities = [['release', config.releaseId], ['campaign', config.campaignRunId]];
    const issuancePaths = identities.map(([kind, id]) => path.join(config.authorityRoot, 'issuance', kind, `${id}.json`));
    if (fs.existsSync(issuancePaths[0])) fail('RELEASE_ID_CONSUMED');
    if (fs.existsSync(issuancePaths[1])) fail('CAMPAIGN_ID_CONSUMED');
    for (const [[kind, id], issuancePath] of identities.map((identity, index) => [identity, issuancePaths[index]])) {
        const issuance = {
            schemaVersion: 1,
            kind,
            id,
            projectName: config.projectName,
            accountId: config.accountId,
            sourceGitHead: config.sourceGitHead,
            sourceGitTree: config.sourceGitTree,
            issuedUtc: config.issuedUtc,
            authorityManifestSha256,
        };
        try {
            writeExclusive(issuancePath, jsonBytes(issuance));
        } catch (error) {
            if (error?.code === 'EEXIST') fail(kind === 'release' ? 'RELEASE_ID_CONSUMED' : 'CAMPAIGN_ID_CONSUMED');
            throw error;
        }
    }
    return { status: 'PREPARED', authorityRoot: config.authorityRoot, authorityManifestSha256 };
}

async function main(argv) {
    if (argv.length !== 2 || argv[0] !== '--config' || !path.isAbsolute(argv[1])) fail('usage: prepare-r14-task7-authority.mjs --config <absolute-config.json>');
    const configPath = argv[1];
    noSymlinkAncestors(configPath, 'authority.config.path');
    if (fs.lstatSync(configPath).isSymbolicLink() || !fs.statSync(configPath).isFile()) fail('authority.config.path');
    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
        fail('authority.config.json');
    }
    await prepareAuthority(config);
    process.stdout.write('R14_TASK7_AUTHORITY=PREPARED\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
