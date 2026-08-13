import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    ENGINES,
    ORIGINS,
    SMOKE_SCHEMA_VERSION,
    STAGES,
    canonicalJson,
    deriveVisibility,
    expectedCaseLabels,
    sha256File,
    validateCase,
    validateManifest,
} from '../../scripts/public-smoke-v2-lib.mjs';
import * as smoke from '../../scripts/public-smoke-v2-lib.mjs';

function tempRoot(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-smoke-v2-contract-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function visibility(overrides = {}) {
    return {
        hiddenAttribute: false,
        display: 'flex',
        position: 'fixed',
        visibility: 'visible',
        opacity: 1,
        clientRects: [{ x: 0, y: 0, width: 40, height: 30, top: 0, right: 40, bottom: 30, left: 0 }],
        intersectionArea: 1200,
        intersectionRatio: 1,
        viewportWidth: 320,
        viewportHeight: 640,
        centerX: 20,
        centerY: 15,
        hitElementId: 'ending-overlay',
        hitIsSelfOrDescendant: true,
        ...overrides,
    };
}

test('the fixed matrix and canonical JSON have no accidental degrees of freedom', () => {
    assert.equal(SMOKE_SCHEMA_VERSION, 2);
    assert.deepEqual(ENGINES, ['chromium', 'firefox', 'webkit']);
    assert.deepEqual(ORIGINS, ['immutable', 'alias']);
    assert.deepEqual(STAGES, ['initial', 'progress', 'ending']);
    assert.deepEqual(expectedCaseLabels(), [
        'chromium-immutable', 'chromium-alias', 'firefox-immutable',
        'firefox-alias', 'webkit-immutable', 'webkit-alias',
    ]);
    assert.equal(canonicalJson({ z: 1, a: { q: true, b: false } }), '{"a":{"b":false,"q":true},"z":1}');
});

test('computed visibility requires every primitive rather than a runner supplied boolean', () => {
    assert.equal(deriveVisibility(visibility()), true);
    for (const [name, broken] of [
        ['hidden attribute', { hiddenAttribute: true }],
        ['display', { display: 'none' }],
        ['position', { position: 'absolute' }],
        ['CSS visibility', { visibility: 'hidden' }],
        ['opacity', { opacity: 0 }],
        ['positive rect', { clientRects: [] }],
        ['viewport intersection area', { intersectionArea: 0 }],
        ['viewport intersection ratio', { intersectionRatio: 0 }],
        ['center hit test', { hitIsSelfOrDescendant: false }],
    ]) assert.equal(deriveVisibility(visibility(broken)), false, name);
    assert.equal(deriveVisibility({ ...visibility(), visible: true, display: 'none' }), false);
});

test('the contract library exposes explicit validators for every Task 1 evidence boundary', () => {
    for (const name of [
        'validateOperationConfig', 'validateDerivedAuditConfig', 'validateCampaignClaims',
        'validateCampaignEnvelope', 'validateCampaignReceipt', 'validateOperationReceipt',
        'validatePngEvidence', 'validateAuditReceipt',
    ]) assert.equal(typeof smoke[name], 'function', `${name} must be a handwritten exact validator`);
});

test('schema validators fail closed on missing, unknown, and wrong-type config fields', () => {
    const config = {
        schemaVersion: 2,
        releaseId: '20260813T010203Z-r14-public-smoke-v2',
        releaseRoot: '/release', acceptedDir: '/release/accepted', failureRoot: '/release/failure',
        operationReceiptPath: '/release/operation.json', auditReceiptPath: '/release/audit.json', negativeReceiptPath: '/release/negative.json', closureRoot: '/release/closure', closureReceiptPath: '/release/closure.json', actualChromeEvidencePath: '/release/chrome.json', releaseReceiptPath: '/release/final.json', workerStdoutPath: '/release/worker.out', workerStderrPath: '/release/worker.err',
        campaignDir: '/campaign', campaignSpecPath: '/campaign/spec.md', campaignReceiptPath: '/campaign/receipt.json', campaignRunId: '20260813T010203Z-r10-korean-release', sourceSnapshotDir: '/campaign/source-snapshot', executionSourceDir: '/execution', authorityProjectRoot: '/authority/project', authorityWorkspaceRoot: '/authority', deploymentRecordPath: '/release/deployment.json', immutableUrl: 'https://abcdef12.penguin-exit-0.pages.dev/', aliasUrl: 'https://penguin-exit-0.pages.dev/', nodeExePath: '/node', nodeExeSha256: 'a'.repeat(64), wranglerJsPath: '/wrangler', wranglerJsSha256: 'b'.repeat(64), projectName: 'penguin-exit-0',
    };
    assert.doesNotThrow(() => smoke.validateOperationConfig(config));
    const missing = { ...config }; delete missing.projectName;
    assert.throws(() => smoke.validateOperationConfig(missing), /config/);
    assert.throws(() => smoke.validateOperationConfig({ ...config, attacker: true }), /config/);
    assert.throws(() => smoke.validateOperationConfig({ ...config, schemaVersion: '2' }), /config/);
});

test('manifest authenticates exactly the regular files below its root', (t) => {
    const root = tempRoot(t);
    const relativePath = 'screenshots/chromium-immutable-initial-320.png';
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.mkdirSync(path.join(root, 'screenshots'));
    fs.writeFileSync(path.join(root, relativePath), png);
    const manifest = {
        schemaVersion: 1,
        releaseId: '20260813T010203Z-r14-public-smoke-v2',
        files: [{ path: relativePath, bytes: png.length, sha256: sha256(png) }],
    };
    manifest.manifestPayloadSha256 = sha256(canonicalJson({ ...manifest }));
    assert.doesNotThrow(() => validateManifest(root, manifest));
    assert.equal(sha256File(path.join(root, relativePath)), sha256(png));
    assert.throws(() => validateManifest(root, { ...manifest, files: [...manifest.files, { ...manifest.files[0] }] }), /duplicate/i);
    assert.throws(() => validateManifest(root, { ...manifest, files: [{ ...manifest.files[0], path: '../outside' }] }), /path|contain/i);
});

test('a case rejects exact signature drift and every forbidden error channel', () => {
    const valid = {
        signature: {
            command: 'archon@stone-igloo:~$ systemctl restart nginx',
            commandKind: 'command',
            system: 'Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.',
            systemKind: 'system',
            roast: '아콘 🐧 // 내 할머니도 너보단 코딩을 잘하겠다.',
            roastKind: 'archon',
            pseudoLabel: '"ARCHON // ROAST"',
            tabs: { wifiAriaSelected: 'false', wifiTabIndex: '-1', cpuAriaSelected: 'true', cpuTabIndex: '0', panelAriaLabelledby: 'cpu-tab', terminalRowsPersisted: true },
        },
        errors: { console: [], page: [], requestFailed: [], http: [], external: [] },
    };
    assert.doesNotThrow(() => validateCase(valid, { partial: true }));
    assert.throws(() => validateCase({ ...valid, signature: { ...valid.signature, roast: 'drift' } }, { partial: true }), /signature\.roast/);
    for (const channel of Object.keys(valid.errors)) {
        const changed = structuredClone(valid);
        changed.errors[channel].push({ injected: true });
        assert.throws(() => validateCase(changed, { partial: true }), new RegExp(`errors\\.${channel}`));
    }
});
