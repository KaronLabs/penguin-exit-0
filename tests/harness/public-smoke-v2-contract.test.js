import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

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
        ['CSS visibility', { visibility: 'hidden' }],
        ['opacity', { opacity: 0 }],
        ['positive rect', { clientRects: [] }],
        ['viewport intersection area', { intersectionArea: 0 }],
        ['viewport intersection ratio', { intersectionRatio: 0 }],
        ['center hit test', { hitIsSelfOrDescendant: false }],
    ]) assert.equal(deriveVisibility(visibility(broken)), false, name);
    assert.equal(deriveVisibility(visibility({ position: 'static' })), true, 'position is observed for every element but fixed is ending-specific');
    assert.throws(() => deriveVisibility({ ...visibility(), visible: true }), /visibility/);
    assertRecursiveSchema(deriveVisibility, visibility(), 'visibility');
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
        releaseRoot: '/authority/release', acceptedDir: '/authority/release/accepted', failureRoot: '/authority/release/failure',
        operationReceiptPath: '/authority/release/operation.json', auditReceiptPath: '/authority/release/audit.json', negativeReceiptPath: '/authority/release/negative.json', closureRoot: '/authority/release/closure', closureReceiptPath: '/authority/release/closure.json', actualChromeEvidencePath: '/authority/release/chrome.json', releaseReceiptPath: '/authority/release/final.json', workerStdoutPath: '/authority/release/worker.out', workerStderrPath: '/authority/release/worker.err',
        campaignDir: '/authority/project/campaign', campaignSpecPath: '/authority/campaign/spec.md', campaignReceiptPath: '/authority/campaign/receipt.json', campaignRunId: '20260813T010203Z-r10-korean-release', sourceSnapshotDir: '/authority/project/campaign/source-snapshot', executionSourceDir: '/authority/project/execution', authorityProjectRoot: '/authority/project', authorityWorkspaceRoot: '/authority', deploymentRecordPath: '/authority/release/deployment.json', deploymentOperatorReceiptPath: '/authority/operations/operator-deployment-receipt.json', immutableUrl: 'https://abcdef12.penguin-exit-0.pages.dev/', aliasUrl: 'https://penguin-exit-0.pages.dev/', nodeExePath: '/node', nodeExeSha256: 'a'.repeat(64), wranglerJsPath: '/wrangler', wranglerJsSha256: 'b'.repeat(64), projectName: 'penguin-exit-0', accountId: '0123456789abcdef0123456789abcdef', sourceGitTree: 'b'.repeat(40),
    };
    assert.doesNotThrow(() => smoke.validateOperationConfig(config));
    const missing = { ...config }; delete missing.projectName;
    assert.throws(() => smoke.validateOperationConfig(missing), /config/);
    assert.throws(() => smoke.validateOperationConfig({ ...config, attacker: true }), /config/);
    assert.throws(() => smoke.validateOperationConfig({ ...config, schemaVersion: '2' }), /config/);
});

test('schema path fields and CLI config reject relative input before resolution', (t) => {
    const fixture = createAcceptedFixture(t);
    const schema2Paths = Object.keys(fixture.config).filter((key) => /(Path|Dir|Root)$/.test(key));
    for (const key of schema2Paths) {
        assert.throws(
            () => smoke.validateOperationConfig({ ...fixture.config, [key]: `relative/${key}` }),
            new RegExp(`config\\.${key}: must be absolute`),
            `schema 2 ${key}`,
        );
    }

    const derived = {
        schemaVersion: 3,
        baseConfigPath: fixture.configPath,
        baseConfigSha256: sha256File(fixture.configPath),
        mutationId: 'NC-RELATIVE-PATH',
        mutationRootRealpath: path.join(fixture.temp, 'mutation'),
        auditTargetRealpath: path.join(fixture.temp, 'mutation', 'accepted'),
        externalOperationReceiptPath: fixture.operationReceiptPath,
        auditReceiptPath: path.join(fixture.temp, 'mutation', 'audit.json'),
    };
    for (const key of ['baseConfigPath', 'mutationRootRealpath', 'auditTargetRealpath', 'externalOperationReceiptPath', 'auditReceiptPath']) {
        assert.throws(
            () => smoke.validateDerivedAuditConfig({ ...derived, [key]: `relative/${key}` }),
            new RegExp(`auditConfig\\.${key}: must be absolute`),
            `schema 3 ${key}`,
        );
    }

    const cli = spawnSync(process.execPath, [path.resolve('scripts/verify-public-smoke-v2.mjs'), '--config', 'relative/config.json'], {
        cwd: fixture.temp,
        encoding: 'utf8',
        timeout: 15_000,
    });
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /absolute/i);
    assert.equal(cli.stdout.includes('PUBLIC_SMOKE_V2_GATE='), false);
    assert.equal(fs.existsSync(fixture.config.auditReceiptPath), false);
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
            roast: '아콘 🐧 // tcpdump는 패킷을 잡는데 넌 멱살을 잡고 싶게 만드는구나. SYN만 보내고 ACK는 언제 줄래?',
            roastKind: 'archon',
            pseudoLabel: '"ARCHON // ROAST"',
            tabs: { wifiAriaSelected: 'false', wifiTabIndex: '-1', cpuAriaSelected: 'true', cpuTabIndex: '0', panelAriaLabelledby: 'tab-cpu', terminalRowsPersisted: true },
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

const RELEASE_ID = '20260813T010203Z-r14-public-smoke-v2';
const CAMPAIGN_ID = '20260813T000000Z-r10-korean-release';
const SOURCE_HEAD = 'c'.repeat(40);
const SOURCE_TREE = 'b'.repeat(40);
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const DEPLOYMENT_ID = 'deadbeef-1234-5678-9abc-def012345678';
const IMMUTABLE_URL = 'https://deadbeef.penguin-exit-0.pages.dev/';
const ALIAS_URL = 'https://penguin-exit-0.pages.dev/';
const BASE_TIME = Date.parse('2026-08-13T01:02:03.000Z');
const PRODUCT_PATHS = ['/', '/content.js', '/game-core.js', '/script.js', '/style.css', '/assets/dangerous-alliance-ssh.png', '/assets/ending-tuna-acquisition.png'];
const MIME = { '/': 'text/html', '/content.js': 'application/javascript', '/game-core.js': 'application/javascript', '/script.js': 'application/javascript', '/style.css': 'text/css', '/assets/dangerous-alliance-ssh.png': 'image/png', '/assets/ending-tuna-acquisition.png': 'image/png' };
const TOKEN = { '/': 'root', '/content.js': 'content-js', '/game-core.js': 'game-core-js', '/script.js': 'script-js', '/style.css': 'style-css', '/assets/dangerous-alliance-ssh.png': 'assets-dangerous-alliance-ssh-png', '/assets/ending-tuna-acquisition.png': 'assets-ending-tuna-acquisition-png' };

function utcAt(offsetMs) {
    return new Date(BASE_TIME + offsetMs).toISOString();
}

function writeFile(file, bytes) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
}

function writeJson(file, value) {
    writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0);
    typeBytes.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
    return result;
}

const PNG_IDAT = new Map();

function png(width, height, marker) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 6, 0, 0, 0], 8);
    const key = `${width}x${height}`;
    if (!PNG_IDAT.has(key)) {
        const raw = Buffer.alloc((width * 4 + 1) * height);
        for (let row = 0; row < height; row += 1) raw[row * (width * 4 + 1)] = 0;
        PNG_IDAT.set(key, zlib.deflateSync(raw));
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('tEXt', Buffer.from(`fixture\0${marker}`, 'utf8')),
        pngChunk('IDAT', PNG_IDAT.get(key)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function walkInventory(root) {
    const files = [];
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(absolute);
            else if (entry.isFile()) {
                const relative = path.relative(root, absolute).split(path.sep).join('/');
                const bytes = fs.readFileSync(absolute);
                files.push({ path: relative, sizeBytes: bytes.length, sha256: sha256(bytes) });
            }
        }
    }
    walk(root);
    files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    return {
        schemaVersion: 1,
        algorithm: 'SHA-256',
        pathEncoding: 'UTF-8 NUL-terminated ordered path records',
        fileCount: files.length,
        pathListSha256: sha256(Buffer.from(files.map((entry) => `${entry.path}\0`).join(''), 'utf8')),
        contentRecordsSha256: sha256(Buffer.from(files.map((entry) => `${entry.path}\0${entry.sizeBytes}\0${entry.sha256}\0`).join(''), 'utf8')),
        files,
    };
}

function sourceProductFiles(source) {
    return Object.fromEntries(PRODUCT_PATHS.map((publicPath) => {
        const relative = publicPath === '/' ? 'index.html' : publicPath.slice(1);
        const bytes = fs.readFileSync(path.join(source, relative));
        return [publicPath, { bytes: bytes.length, mime: MIME[publicPath], sha256: sha256(bytes) }];
    }));
}

function visibleElement(position = 'static', id = 'npc-card', viewport = { width: 320, height: 640 }) {
    return {
        hiddenAttribute: false, display: 'block', position, visibility: 'visible', opacity: 1,
        clientRects: [{ x: 8, y: 8, width: 100, height: 40, top: 8, right: 108, bottom: 48, left: 8 }],
        intersectionArea: 4000, intersectionRatio: 1, viewportWidth: viewport.width, viewportHeight: viewport.height,
        centerX: 58, centerY: 28, hitElementId: id, hitIsSelfOrDescendant: true,
    };
}

function hiddenEnding() {
    return {
        hiddenAttribute: false, display: 'none', position: 'fixed', visibility: 'visible', opacity: 1,
        clientRects: [], intersectionArea: 0, intersectionRatio: 0, viewportWidth: 320, viewportHeight: 640,
        centerX: 0, centerY: 0, hitElementId: '', hitIsSelfOrDescendant: false,
    };
}

function endingVisibility() {
    return { ...visibleElement('fixed', 'ending-overlay', { width: 640, height: 360 }), display: 'flex', viewportWidth: 640, viewportHeight: 360 };
}

function state(units, stars, incidentCost, activeIntrusion) {
    return { units, stars, incidentCost, activeIntrusion };
}

function actionContract() {
    const result = [
        ['locator.click', '#tab-wifi'],
        ['locator.click', 'role=button[name="3. systemctl restart nginx (무작정 재시작)"]'],
        ['locator.click', '#tab-cpu'],
        ['locator.click', '#tab-wifi'],
        ['locator.click', 'role=button[name="1. ping 8.8.8.8 (안전한 SRE 진단)"]'],
    ];
    for (let block = 0; block < 4; block += 1) {
        for (let click = 0; click < 5; click += 1) result.push(['locator.click', '#btn-produce']);
        result.push(['locator.click', block === 0 ? '#btn-accept-penalty' : '#btn-revert']);
    }
    for (let click = 0; click < 47; click += 1) result.push(['locator.click', '#btn-produce']);
    result.push(['keyboard.press', 'Tab'], ['keyboard.press', 'Shift+Tab']);
    assert.equal(result.length, 78);
    return result;
}

function buildActions(label, url, caseIndex) {
    const startOffset = 10_000 + caseIndex * 20_000;
    return actionContract().map(([api, target], index) => ({
        seq: index + 1,
        utc: utcAt(startOffset + (index < 3 ? 100 + index * 100 : 400 + (index - 3) * 50)),
        monotonicMs: startOffset + (index < 3 ? 100 + index * 100 : 400 + (index - 3) * 50),
        api,
        target,
        preStateSha256: sha256(`${label}-state-${index}`),
        postStateSha256: sha256(`${label}-state-${index + 1}`),
        resultingUrl: url,
    }));
}

function quoteSnapshot(count) {
    const discovered = count === 1 ? ['puzzle:0'] : ['puzzle:0', 'puzzle:1'];
    const parsed = { version: 2, cursors: { puzzle: count, repeat: 0, ai: 0, codeReview: 0 }, discovered };
    return { counterText: `아콘 독설 수집 ${count}/100`, counter: count, serialized: JSON.stringify(parsed), parsed };
}

function buildCase(fixture, engine, originKind, caseIndex) {
    const label = `${engine}-${originKind}`;
    const requestedUrl = originKind === 'immutable' ? IMMUTABLE_URL : ALIAS_URL;
    const actions = buildActions(label, requestedUrl, caseIndex);
    const intrusions = [
        ['copilot', '🤖 Copilot 코드 침입!', 'Copilot이 반복되는 나쁜 코드를 생성했습니다! Esc 또는 git revert로 되돌리세요.', '아콘 🐧 // AI가 짜준 코드 복붙하다가 서버 터지면 AI가 책임지냐? 네 목통이 터지는 거다.', '페널티 수락 (-500★)', 10, 11, state(50, 750, 0, 'copilot'), state(50, 250, 500, null)],
        ['codex', '🧠 Codex 타입 침입!', 'Codex가 변수명을 finalFinalV7로 바꿨습니다! unsafe_cast를 수정하세요.', '아콘 🐧 // 챗GPT한테 네 연봉도 대신 받아달라고 하지 그러냐?', 'Fix unsafe_cast (Esc)', 16, 17, state(100, 1000, 500, 'codex'), state(100, 1000, 500, null)],
        ['gemini', '✨ Gemini 응답 지연!', 'Gemini가 응답을 생성 중입니다... 3초 후 자동 해제되며 Esc로도 해제할 수 있습니다.', '아콘 🐧 // Copilot이 짠 코드를 리뷰도 없이 푸시(Push)해? 넌 내일부터 Copilot의 키보드 받침대다.', 'Dismiss (Esc)', 22, 23, state(150, 1750, 500, 'gemini'), state(150, 1750, 500, null)],
        ['ceo', '💼 CEO 금요일 17:59 배포 지시!', 'CEO가 즉시 프로덕션 배포를 요구합니다!', '아콘 🐧 // AI 개싸움판에 낀 걸 환영한다. 근데 네가 제일 약해 보인다.', 'Reject (-500★)', 28, 29, state(200, 2500, 500, 'ceo'), state(200, 2000, 1000, null)],
    ].map(([type, title, body, aiQuoteText, resolutionControlName, triggerActionSeq, resolutionActionSeq, before, after], index) => ({
        ordinal: index + 1, type, title, body, triggerActionSeq, aiQuoteText, aiQuoteKind: 'archon', aiQuotesBefore: index,
        aiQuotesAfter: index + 1, produceAccessibleName: 'AI 침입 대응 중: 생산 작업 잠김', resolutionActionSeq,
        resolutionControlName, before, after,
    }));
    let stars = 2000;
    const recoveries = Array.from({ length: 47 }, (_, index) => {
        const delta = Math.min(150, 9000 - stars);
        const before = state(200, stars, 1000, null);
        stars += delta;
        return { actionSeq: 30 + index, controlAccessibleName: 'RECOVER: 생산량 변화 없이 GitHub 스타 150 복구', before, after: state(200, stars, 1000, null), starDelta: delta };
    });
    const stages = [
        ['initial', 320, 640, 20],
        ['progress', 320, 640, 350],
        ['ending', 640, 360, 4500],
    ];
    const screenshots = stages.map(([stage, width, height, offset]) => {
        const relativePath = `screenshots/${label}-${stage === 'ending' ? 'ending-640' : `${stage}-320`}.png`;
        const marker = stage === 'progress' && ['chromium-alias', 'firefox-immutable'].includes(label) ? 'shared-progress' : `${label}-${stage}`;
        const pngBytes = png(width, height, marker);
        writeFile(path.join(fixture.acceptedDir, relativePath), pngBytes);
        return {
            caseLabel: label, stage, relativePath, viewport: { width, height }, requestedOrigin: new URL(requestedUrl).origin,
            finalUrl: requestedUrl, oracleSnapshotSha256: sha256(`${label}-${stage}-oracle`),
            captureStartedUtc: utcAt(10_000 + caseIndex * 20_000 + offset),
            captureFinishedUtc: utcAt(10_000 + caseIndex * 20_000 + offset + 10), bytes: pngBytes.length, sha256: sha256(pngBytes),
        };
    });
    return {
        schemaVersion: 2, label, engine, browserVersion: `${engine}-fixture-1`, originKind, requestedUrl, finalUrl: requestedUrl, attempt: 1,
        startedUtc: utcAt(10_000 + caseIndex * 20_000), finishedUtc: utcAt(15_000 + caseIndex * 20_000),
        startedMonotonicMs: 10_000 + caseIndex * 20_000, finishedMonotonicMs: 15_000 + caseIndex * 20_000,
        actions,
        initial: { endingVisibility: hiddenEnding(), endingRole: 'dialog', endingAriaModal: 'true', endingAriaLabelledby: 'ending-process-heading', endingAccessibleName: '프로세스는 살아남았습니다', backgroundInert: { header: false, dashboard: false, intrusionBanner: false, mainGrid: false }, activeElementId: '', produceDisabled: false, produceAccessibleName: '코드 작성: 생산량 10과 GitHub 스타 150 획득' },
        signature: { command: 'archon@stone-igloo:~$ systemctl restart nginx', commandKind: 'command', system: 'Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.', systemKind: 'system', roast: '아콘 🐧 // tcpdump는 패킷을 잡는데 넌 멱살을 잡고 싶게 만드는구나. SYN만 보내고 ACK는 언제 줄래?', roastKind: 'archon', pseudoLabel: '"ARCHON // ROAST"', tabs: { wifiAriaSelected: 'false', wifiTabIndex: '-1', cpuAriaSelected: 'true', cpuTabIndex: '0', panelAriaLabelledby: 'tab-cpu', terminalRowsPersisted: true } },
        quotePersistence: { afterBad: quoteSnapshot(1), beforeReload: quoteSnapshot(1), afterReload: quoteSnapshot(1), afterFair: quoteSnapshot(2) },
        npc: { icon: '🐻', name: 'Polar Bear DevOps', message: 'Wi-Fi는 살아났습니다. 참치 한 캔은 제 쪽에서 처리하죠.', visibility: visibleElement('static', 'npc-card') },
        intrusions,
        penalty: { actionSeq: 11, controlAccessibleName: '페널티 수락 (-500★)', before: state(50, 750, 0, 'copilot'), after: state(50, 250, 500, null), starDelta: -500 },
        recoveries,
        ending: { visibility: endingVisibility(), role: 'dialog', ariaModal: 'true', ariaLabelledby: 'ending-process-heading', accessibleName: '프로세스는 살아남았습니다', initialFocusId: 'btn-play-again', tabFocusId: 'btn-play-again', shiftTabFocusId: 'btn-play-again', backgroundInert: { header: true, dashboard: true, intrusionBanner: true, mainGrid: true }, produceDisabled: true, produceAccessibleName: 'EXIT 0 달성', tokens: ['PROCESS EXIT CODE: 0', 'FINANCIAL EXIT CODE: 1', '+$3,000', '-$3,001', '-$1', '샘 알트먼의 인수 제안', 'Chief Tuna Prompt Engineer'] },
        errors: { console: [], page: [], requestFailed: [], http: [], external: [] },
        screenshots,
    };
}

function eventRecord(events, type, caseLabel, payload, utc, monotonicMs) {
    const previousEventSha256 = events.length === 0 ? '0'.repeat(64) : events.at(-1).eventSha256;
    const event = { seq: events.length + 1, previousEventSha256, utc, monotonicMs, type, case: caseLabel, payload };
    event.eventSha256 = sha256(canonicalJson(event));
    events.push(event);
}

function buildEvents(cases) {
    const events = [];
    eventRecord(events, 'operation-start', null, { releaseId: RELEASE_ID, matrix: expectedCaseLabels() }, utcAt(9_000), 9_000);
    for (const record of cases) {
        eventRecord(events, 'case-start', record.label, { engine: record.engine, originKind: record.originKind, requestedUrl: record.requestedUrl }, record.startedUtc, record.startedMonotonicMs);
        const [initial, progress, ending] = record.screenshots;
        for (const screenshot of [initial]) {
            eventRecord(events, 'screenshot-oracle', record.label, { stage: screenshot.stage, oracleSha256: screenshot.oracleSnapshotSha256 }, screenshot.captureStartedUtc, Date.parse(screenshot.captureStartedUtc) - BASE_TIME);
            eventRecord(events, 'screenshot-written', record.label, { stage: screenshot.stage, path: screenshot.relativePath, pngSha256: screenshot.sha256, oracleSha256: screenshot.oracleSnapshotSha256 }, screenshot.captureFinishedUtc, Date.parse(screenshot.captureFinishedUtc) - BASE_TIME);
        }
        for (const action of record.actions.slice(0, 3)) eventRecord(events, 'trusted-input', record.label, { actionSeq: action.seq, api: action.api, target: action.target, preStateSha256: action.preStateSha256, postStateSha256: action.postStateSha256, resultingUrl: action.resultingUrl }, action.utc, action.monotonicMs);
        for (const screenshot of [progress]) {
            eventRecord(events, 'screenshot-oracle', record.label, { stage: screenshot.stage, oracleSha256: screenshot.oracleSnapshotSha256 }, screenshot.captureStartedUtc, Date.parse(screenshot.captureStartedUtc) - BASE_TIME);
            eventRecord(events, 'screenshot-written', record.label, { stage: screenshot.stage, path: screenshot.relativePath, pngSha256: screenshot.sha256, oracleSha256: screenshot.oracleSnapshotSha256 }, screenshot.captureFinishedUtc, Date.parse(screenshot.captureFinishedUtc) - BASE_TIME);
        }
        for (const action of record.actions.slice(3)) eventRecord(events, 'trusted-input', record.label, { actionSeq: action.seq, api: action.api, target: action.target, preStateSha256: action.preStateSha256, postStateSha256: action.postStateSha256, resultingUrl: action.resultingUrl }, action.utc, action.monotonicMs);
        for (const screenshot of [ending]) {
            eventRecord(events, 'screenshot-oracle', record.label, { stage: screenshot.stage, oracleSha256: screenshot.oracleSnapshotSha256 }, screenshot.captureStartedUtc, Date.parse(screenshot.captureStartedUtc) - BASE_TIME);
            eventRecord(events, 'screenshot-written', record.label, { stage: screenshot.stage, path: screenshot.relativePath, pngSha256: screenshot.sha256, oracleSha256: screenshot.oracleSnapshotSha256 }, screenshot.captureFinishedUtc, Date.parse(screenshot.captureFinishedUtc) - BASE_TIME);
        }
        eventRecord(events, 'case-finish', record.label, { actionCount: 78, finalUrl: record.finalUrl }, record.finishedUtc, record.finishedMonotonicMs);
    }
    eventRecord(events, 'operation-finish', null, { caseCount: 6, screenshotCount: 18 }, utcAt(115_100), 115_100);
    assert.equal(events.length, 518);
    return events;
}

function rehashEventChain(events) {
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

function manifestFor(root) {
    const files = [];
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(absolute);
            else if (entry.isFile() && path.relative(root, absolute).split(path.sep).join('/') !== 'artifact-manifest.json') {
                const bytes = fs.readFileSync(absolute);
                files.push({ path: path.relative(root, absolute).split(path.sep).join('/'), bytes: bytes.length, sha256: sha256(bytes) });
            }
        }
    }
    walk(root);
    files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const manifest = { schemaVersion: 1, releaseId: RELEASE_ID, files };
    manifest.manifestPayloadSha256 = sha256(canonicalJson(manifest));
    return manifest;
}

function sealAccepted(fixture) {
    const manifest = manifestFor(fixture.acceptedDir);
    writeJson(path.join(fixture.acceptedDir, 'artifact-manifest.json'), manifest);
    return manifest;
}

function makeWranglerCapture(fixture, phase, startedOffset, finishedOffset) {
    const stdoutPath = `control-plane/${phase}.stdout.bin`;
    const stderrPath = `control-plane/${phase}.stderr.bin`;
    const commandPath = `control-plane/${phase}.command.json`;
    const row = [{ Id: DEPLOYMENT_ID, Environment: 'Production', Branch: 'main', Source: SOURCE_HEAD.slice(0, 7), Deployment: IMMUTABLE_URL, Status: 'success', Build: 'success' }];
    const stdout = Buffer.from(`${JSON.stringify(row)}\n`);
    const stderr = Buffer.alloc(0);
    writeFile(path.join(fixture.acceptedDir, stdoutPath), stdout);
    writeFile(path.join(fixture.acceptedDir, stderrPath), stderr);
    const argv = [fixture.config.nodeExePath, fixture.config.wranglerJsPath, 'pages', 'deployment', 'list', '--project-name', 'penguin-exit-0', '--environment', 'production', '--json'];
    const capture = {
        schemaVersion: 1, phase, argv, cwd: fixture.project, startedUtc: utcAt(startedOffset), finishedUtc: utcAt(finishedOffset), exitCode: 0,
        nodeSha256: fixture.config.nodeExeSha256, wranglerSha256: fixture.config.wranglerJsSha256,
        stdoutPath, stdoutBytes: stdout.length, stdoutSha256: sha256(stdout), stderrPath, stderrBytes: 0, stderrSha256: sha256(stderr),
    };
    writeJson(path.join(fixture.acceptedDir, commandPath), capture);
    return { capture, commandPath };
}

function publicUrl(origin, publicPath) {
    return new URL(publicPath === '/' ? '/' : publicPath.slice(1), origin).href;
}

function makeFileProbe(fixture, phase, originKinds, startedOffset) {
    const results = [];
    let cursor = startedOffset;
    for (const originKind of originKinds) {
        const origin = originKind === 'immutable' ? IMMUTABLE_URL : ALIAS_URL;
        const prefix = phase === 'initial' ? `initial-${originKind}` : 'final-alias';
        for (const publicPath of PRODUCT_PATHS) {
            const bodyPath = `file-probes/bodies/${prefix}-${TOKEN[publicPath]}.bin`;
            const sourceRelative = publicPath === '/' ? 'index.html' : publicPath.slice(1);
            const bytes = fs.readFileSync(path.join(fixture.sourceSnapshot, sourceRelative));
            writeFile(path.join(fixture.acceptedDir, bodyPath), bytes);
            results.push({
                originKind, path: publicPath, requestedUrl: publicUrl(origin, publicPath), finalUrl: publicUrl(origin, publicPath), redirects: [], status: 200,
                contentType: `${MIME[publicPath]}; charset=utf-8`, mime: MIME[publicPath], bodyPath, bytes: bytes.length, sha256: sha256(bytes),
                startedUtc: utcAt(cursor), finishedUtc: utcAt(cursor + 10), transportError: null,
            });
            cursor += 20;
        }
    }
    const probe = {
        schemaVersion: 2, phase, startedUtc: utcAt(startedOffset), finishedUtc: utcAt(cursor), expectedSourceGitHead: SOURCE_HEAD,
        expectedDeploymentId: DEPLOYMENT_ID, results, passed: results.length, total: results.length,
    };
    const relativePath = phase === 'initial' ? 'file-probes/initial-10.json' : 'file-probes/final-alias-5.json';
    writeJson(path.join(fixture.acceptedDir, relativePath), probe);
    return { probe, relativePath };
}

function commandCapture({ argv, cwd, startedOffset, finishedOffset, stdoutPath, stderrPath, stdout, stderr, extra = {} }) {
    return {
        argv, cwd, startedUtc: utcAt(startedOffset), finishedUtc: utcAt(finishedOffset), startedMonotonicMs: startedOffset,
        finishedMonotonicMs: finishedOffset, exitCode: 0, signal: null, stdoutPath, stdoutBytes: stdout.length, stdoutSha256: sha256(stdout),
        stderrPath, stderrBytes: stderr.length, stderrSha256: sha256(stderr), ...extra,
    };
}

function createCampaign(fixture) {
    const sourceFiles = {
        'index.html': '<!doctype html><title>fixture</title>\n',
        'content.js': 'export const fixtureContent = true;\n',
        'game-core.js': 'export const fixtureCore = true;\n',
        'script.js': 'export const fixtureScript = true;\n',
        'style.css': 'body { display: block; }\n',
        'assets/dangerous-alliance-ssh.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        'assets/ending-tuna-acquisition.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        'scripts/verify-r10-campaign.mjs': 'export const verifier = true;\n',
        'scripts/run-public-smoke-v2-operation.mjs': 'export const orchestrator = true;\n',
        'scripts/run-public-smoke-v2.mjs': 'export const runner = true;\n',
        'scripts/public-smoke-v2-lib.mjs': 'export const library = true;\n',
    };
    for (const [relative, bytes] of Object.entries(sourceFiles)) writeFile(path.join(fixture.sourceSnapshot, relative), bytes);
    const inventory = walkInventory(fixture.sourceSnapshot);
    writeJson(path.join(fixture.campaignDir, 'candidate-inventory.json'), inventory);
    writeFile(fixture.campaignSpecPath, '# fixture campaign v5\n');
    const rawSummary = Buffer.from('{"summary":true}\n');
    const rawSamples = Buffer.from('[1,2,3]\n');
    writeFile(path.join(fixture.campaignDir, 'performance-summary.json'), rawSummary);
    writeFile(path.join(fixture.campaignDir, 'frame-samples.json'), rawSamples);
    for (const name of ['r9-before.json', 'r9-after.json', 'r10-before.json', 'r10-after.json']) writeJson(path.join(fixture.campaignDir, name), { frozen: name.split('-')[0] });
    writeFile(path.join(fixture.campaignDir, 'ledger.jsonl'), `${JSON.stringify({ schemaVersion: 5, runId: CAMPAIGN_ID, state: 'VERIFIED' })}\n`);
    writeJson(path.join(fixture.campaignDir, 'artifact-manifest.json'), []);
    const frozen = { fileCount: 1, pathListSha256: sha256('frozen-path'), beforeDigest: sha256('frozen'), afterDigest: sha256('frozen') };
    const claims = {
        schemaVersion: 5, runId: CAMPAIGN_ID, v1Sha256: sha256('v1'),
        candidateInventory: { fileCount: inventory.fileCount, pathListSha256: inventory.pathListSha256, contentRecordsSha256: inventory.contentRecordsSha256 },
        gameCoreSha256: sourceProductFiles(fixture.sourceSnapshot)['/game-core.js'].sha256,
        sourceGit: { branch: 'main', headSha: SOURCE_HEAD },
        unit: { tests: 29, passed: 29, failed: 0, exitCode: 0 },
        browser: { chromium: { passed: 16, failed: 0 }, firefox: { passed: 16, failed: 0 }, webkit: { passed: 16, failed: 0 }, integrity: true, reportedFailures: 0, exitCode: 0 },
        performance: { startedUtc: utcAt(-600_000), endedUtc: utcAt(-1_000), measuredDurationMs: 599_000, environment: { nodeVersion: 'v22.21.1', platform: 'win32', arch: 'x64', project: 'chromium-perf' }, sampleCount: 100, rawMinMs: 1, rawMaxMs: 20, p50LatencyMs: 10, p95LatencyMs: 18, p99LatencyMs: 20, longTaskObserverSupported: true, longTasksCount: 0, heapStartMb: 1, heapEndMb: 2, heapNetGrowthMb: 1, totalActionsCount: 100 },
        negativeControls: { passed: 21, total: 21, failed: 0, exitCode: 0 },
        campaignVerifier: { tests: 6, passed: 6, failed: 0, exitCode: 0 },
        r9Frozen: frozen, r10Frozen: { ...frozen, pathListSha256: sha256('r10-path'), beforeDigest: sha256('r10'), afterDigest: sha256('r10') },
        actualBrowserZoom: { claimed: false, equivalentReflow: '3-engine 640x360 equivalent PASS', limitation: 'actual browser chrome zoom not claimed' },
    };
    writeJson(path.join(fixture.campaignDir, 'claims.json'), claims);
    const payloadNames = ['artifact-manifest.json', 'candidate-inventory.json', 'claims.json', 'ledger.jsonl', 'r9-before.json', 'r9-after.json', 'r10-before.json', 'r10-after.json'];
    const envelope = {
        schemaVersion: 5, runId: CAMPAIGN_ID,
        payloadHashes: Object.fromEntries(payloadNames.map((name) => [name, sha256File(path.join(fixture.campaignDir, name))])),
        source: { path: 'source-snapshot', fileCount: inventory.fileCount, pathListSha256: inventory.pathListSha256, contentRecordsSha256: inventory.contentRecordsSha256, gitBranch: 'main', gitHeadSha: SOURCE_HEAD },
        spec: { fileName: path.basename(fixture.campaignSpecPath), sizeBytes: fs.statSync(fixture.campaignSpecPath).size, sha256: sha256File(fixture.campaignSpecPath) },
        rawEvidence: { summary: { path: 'performance-summary.json', sha256: sha256(rawSummary) }, samples: { path: 'frame-samples.json', sha256: sha256(rawSamples) } },
    };
    writeJson(path.join(fixture.campaignDir, 'submission-envelope.json'), envelope);
    const commandStdout = Buffer.from('ok\n');
    const commandStderr = Buffer.alloc(0);
    writeFile(path.join(fixture.campaignDir, 'commands/unit.stdout.log'), commandStdout);
    writeFile(path.join(fixture.campaignDir, 'commands/unit.stderr.log'), commandStderr);
    const command = { key: '30-unit', argv: [fixture.config.nodeExePath, '--test'], cwd: fixture.executionSource, startedUtc: utcAt(-10_000), endedUtc: utcAt(-9_000), timeoutMs: 120_000, timedOut: false, exitCode: 0, signal: null, stdoutPath: 'commands/unit.stdout.log', stdoutSha256: sha256(commandStdout), stderrPath: 'commands/unit.stderr.log', stderrSha256: sha256(commandStderr) };
    const receipt = {
        schemaVersion: 1, runId: CAMPAIGN_ID, status: 'VERIFIED', createdUtc: utcAt(-700_000), completedUtc: utcAt(-500), projectRoot: fixture.project, cleanRoot: fixture.executionSource,
        campaign: { path: fixture.campaignDir, artifactManifestSha256: sha256File(path.join(fixture.campaignDir, 'artifact-manifest.json')), submissionEnvelopeSha256: sha256File(path.join(fixture.campaignDir, 'submission-envelope.json')) },
        spec: { path: fixture.campaignSpecPath, sizeBytes: fs.statSync(fixture.campaignSpecPath).size, sha256: sha256File(fixture.campaignSpecPath) },
        candidateInventory: claims.candidateInventory, gameCoreSha256: claims.gameCoreSha256, sourceGit: claims.sourceGit,
        r9Frozen: claims.r9Frozen, r10Frozen: claims.r10Frozen, commands: [command], limitation: claims.actualBrowserZoom,
        publicationState: 'COMMITTED only when operation SUCCESS.json exists and binds this receipt',
    };
    writeJson(fixture.campaignReceiptPath, receipt);
    return { inventory, claims, envelope, receipt };
}

function createAcceptedFixture(t) {
    const temp = tempRoot(t);
    const workspace = path.join(temp, 'authority-workspace');
    const project = path.join(workspace, 'project');
    const releaseRoot = path.join(workspace, 'review', RELEASE_ID);
    const acceptedDir = path.join(releaseRoot, 'accepted');
    const campaignDir = path.join(project, 'evidence', 'campaigns', CAMPAIGN_ID);
    const sourceSnapshot = path.join(campaignDir, 'source-snapshot');
    const executionSource = path.join(project, '.campaign-operations', CAMPAIGN_ID, 'clean-source');
    const campaignSpecPath = path.join(workspace, 'review', `spec_${CAMPAIGN_ID}_mission02_r10_korean_release.md`);
    const campaignReceiptPath = path.join(workspace, 'review', `receipt_${CAMPAIGN_ID}_campaign.json`);
    const configPath = path.join(releaseRoot, 'operation-config.json');
    const operationReceiptPath = path.join(releaseRoot, 'operation-receipt.json');
    const deploymentRecordPath = path.join(releaseRoot, 'deployment-record.json');
    const deploymentOperatorReceiptPath = path.join(releaseRoot, 'operator-deployment-receipt.json');
    const nodeExePath = path.join(workspace, 'tools', 'node.exe');
    const wranglerJsPath = path.join(workspace, 'tools', 'wrangler.js');
    writeFile(nodeExePath, 'fixture node executable\n');
    writeFile(wranglerJsPath, 'fixture wrangler 4.121.0\n');
    fs.mkdirSync(executionSource, { recursive: true });
    fs.mkdirSync(acceptedDir, { recursive: true });
    const config = {
        schemaVersion: 2, releaseId: RELEASE_ID, releaseRoot, acceptedDir, failureRoot: path.join(releaseRoot, 'failure'),
        operationReceiptPath, auditReceiptPath: path.join(releaseRoot, 'audit-receipt.json'), negativeReceiptPath: path.join(releaseRoot, 'negative-receipt.json'),
        closureRoot: path.join(releaseRoot, 'closure'), closureReceiptPath: path.join(releaseRoot, 'closure', 'receipt.json'),
        actualChromeEvidencePath: path.join(releaseRoot, 'actual-chrome.json'), releaseReceiptPath: path.join(releaseRoot, 'final-receipt.json'),
        workerStdoutPath: path.join(releaseRoot, 'worker.stdout.bin'), workerStderrPath: path.join(releaseRoot, 'worker.stderr.bin'),
        campaignDir, campaignSpecPath, campaignReceiptPath, campaignRunId: CAMPAIGN_ID, sourceSnapshotDir: sourceSnapshot,
        executionSourceDir: executionSource, authorityProjectRoot: project, authorityWorkspaceRoot: workspace, deploymentRecordPath, deploymentOperatorReceiptPath,
        immutableUrl: IMMUTABLE_URL, aliasUrl: ALIAS_URL, nodeExePath, nodeExeSha256: sha256File(nodeExePath),
        wranglerJsPath, wranglerJsSha256: sha256File(wranglerJsPath), projectName: 'penguin-exit-0', accountId: ACCOUNT_ID, sourceGitTree: SOURCE_TREE,
    };
    const fixture = { temp, workspace, project, releaseRoot, acceptedDir, campaignDir, sourceSnapshot, executionSource, campaignSpecPath, campaignReceiptPath, configPath, operationReceiptPath, deploymentRecordPath, deploymentOperatorReceiptPath, config };
    createCampaign(fixture);
    const productFiles = sourceProductFiles(sourceSnapshot);
    writeJson(deploymentRecordPath, { schemaVersion: 1, projectName: 'penguin-exit-0', deploymentId: DEPLOYMENT_ID, environment: 'Production', branch: 'main', sourceGitHead: SOURCE_HEAD, immutableUrl: IMMUTABLE_URL, aliasUrl: ALIAS_URL, productFiles, capturedUtc: utcAt(-100) });
    const deploymentRecordBytes = fs.readFileSync(deploymentRecordPath);
    writeJson(deploymentOperatorReceiptPath, { schemaVersion: 1, operation: 'deploy', releaseId: RELEASE_ID, campaignRunId: CAMPAIGN_ID, projectName: 'penguin-exit-0', accountId: ACCOUNT_ID, environment: 'Production', branch: 'main', sourceGitHead: SOURCE_HEAD, sourceGitTree: SOURCE_TREE, deploymentRecordPath, deploymentRecordBytes: deploymentRecordBytes.length, deploymentRecordSha256: sha256(deploymentRecordBytes), deploymentId: DEPLOYMENT_ID, immutableUrl: IMMUTABLE_URL, aliasUrl: ALIAS_URL, createdUtc: utcAt(-50) });
    writeJson(configPath, config);

    const cases = expectedCaseLabels().map((label, index) => {
        const [engine, originKind] = label.split('-');
        return buildCase(fixture, engine, originKind, index);
    });
    writeJson(path.join(acceptedDir, 'observations.json'), cases);
    const events = buildEvents(cases);
    writeFile(path.join(acceptedDir, 'runner-events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const acceptedRun = {
        schemaVersion: 2, releaseId: RELEASE_ID, campaignRunId: CAMPAIGN_ID, sourceGitHead: SOURCE_HEAD, deploymentId: DEPLOYMENT_ID,
        immutableUrl: IMMUTABLE_URL, aliasUrl: ALIAS_URL, startedUtc: utcAt(9_000), finishedUtc: utcAt(115_100), startedMonotonicMs: 9_000,
        finishedMonotonicMs: 115_100, engines: ENGINES, originKinds: ORIGINS, attemptsPerCase: 1, retries: 0, skips: 0,
        caseLabels: expectedCaseLabels(), observationsPath: 'observations.json', eventsPath: 'runner-events.jsonl', screenshotCount: 18, productFiles,
        tooling: {
            runner: { path: 'scripts/run-public-smoke-v2.mjs', version: '1', sha256: sha256File(path.join(sourceSnapshot, 'scripts/run-public-smoke-v2.mjs')) },
            library: { path: 'scripts/public-smoke-v2-lib.mjs', version: '1', sha256: sha256File(path.join(sourceSnapshot, 'scripts/public-smoke-v2-lib.mjs')) },
            playwright: { path: 'node_modules/playwright/index.js', version: '1.62.1', sha256: sha256('playwright-1.62.1') },
        },
    };
    writeJson(path.join(acceptedDir, 'accepted-run.json'), acceptedRun);
    const initialProbe = makeFileProbe(fixture, 'initial', ['immutable', 'alias'], 7_000);
    const pre = makeWranglerCapture(fixture, 'pre', 8_000, 8_100);
    const mid = makeWranglerCapture(fixture, 'mid', 66_000, 66_100);
    const post = makeWranglerCapture(fixture, 'post', 115_200, 115_300);
    const finalProbe = makeFileProbe(fixture, 'final-alias', ['alias'], 115_400);
    const manifest = sealAccepted(fixture);

    const verifierStdout = Buffer.from('R10_CAMPAIGN_GATE=VERIFIED\n');
    const empty = Buffer.alloc(0);
    const verifierStdoutPath = path.join(releaseRoot, 'campaign-verifier.stdout.bin');
    const verifierStderrPath = path.join(releaseRoot, 'campaign-verifier.stderr.bin');
    writeFile(verifierStdoutPath, verifierStdout);
    writeFile(verifierStderrPath, empty);
    writeFile(config.workerStdoutPath, empty);
    writeFile(config.workerStderrPath, empty);
    const verifierPath = path.join(sourceSnapshot, 'scripts', 'verify-r10-campaign.mjs');
    const orchestratorPath = path.join(sourceSnapshot, 'scripts', 'run-public-smoke-v2-operation.mjs');
    const runnerPath = path.join(sourceSnapshot, 'scripts', 'run-public-smoke-v2.mjs');
    const verifierArgv = [config.nodeExePath, verifierPath, '--campaign', campaignDir, '--spec', campaignSpecPath, '--source', sourceSnapshot, '--execution-source', executionSource, '--run', CAMPAIGN_ID, '--authority-project', project, '--authority-workspace', workspace];
    const workerArgv = [config.nodeExePath, runnerPath, '--config', configPath];
    const screenshotBindings = cases.flatMap((record) => record.screenshots.map((screenshot) => ({ case: screenshot.caseLabel, stage: screenshot.stage, path: screenshot.relativePath, pngSha256: screenshot.sha256, oracleSha256: screenshot.oracleSnapshotSha256, captureStartUtc: screenshot.captureStartedUtc, captureEndUtc: screenshot.captureFinishedUtc })));
    const eventsSha256 = sha256File(path.join(acceptedDir, 'runner-events.jsonl'));
    const manifestSha256 = sha256File(path.join(acceptedDir, 'artifact-manifest.json'));
    const operationReceipt = {
        schemaVersion: 1, releaseId: RELEASE_ID, createdUtc: utcAt(116_000), status: 'VERIFIED', configPath, configSha256: sha256File(configPath),
        orchestratorPath, orchestratorSha256: sha256File(orchestratorPath),
        campaignVerifier: commandCapture({ argv: verifierArgv, cwd: project, startedOffset: 5_000, finishedOffset: 6_000, stdoutPath: verifierStdoutPath, stderrPath: verifierStderrPath, stdout: verifierStdout, stderr: empty, extra: { gateLine: 'R10_CAMPAIGN_GATE=VERIFIED', verifierPath, verifierSha256: sha256File(verifierPath) } }),
        worker: commandCapture({ argv: workerArgv, cwd: project, startedOffset: 6_500, finishedOffset: 115_900, stdoutPath: config.workerStdoutPath, stderrPath: config.workerStderrPath, stdout: empty, stderr: empty }),
        accepted: { realpath: fs.realpathSync(acceptedDir), manifestPath: path.join(acceptedDir, 'artifact-manifest.json'), manifestSha256, treeDigest: sha256(canonicalJson({ files: manifest.files, manifestSha256 })), publishedUtc: utcAt(115_800), eventsPath: path.join(acceptedDir, 'runner-events.jsonl'), eventsSha256, eventCount: 518, finalEventSha256: events.at(-1).eventSha256 },
        screenshotBindings,
        cloudflareReads: {
            pre: { capturePath: pre.commandPath, captureSha256: sha256File(path.join(acceptedDir, pre.commandPath)), deploymentId: DEPLOYMENT_ID },
            mid: { capturePath: mid.commandPath, captureSha256: sha256File(path.join(acceptedDir, mid.commandPath)), deploymentId: DEPLOYMENT_ID },
            post: { capturePath: post.commandPath, captureSha256: sha256File(path.join(acceptedDir, post.commandPath)), deploymentId: DEPLOYMENT_ID },
        },
        fileProbes: { initialPath: initialProbe.relativePath, initialSha256: sha256File(path.join(acceptedDir, initialProbe.relativePath)), initialPassed: 14, initialTotal: 14, finalAliasPath: finalProbe.relativePath, finalAliasSha256: sha256File(path.join(acceptedDir, finalProbe.relativePath)), finalAliasPassed: 7, finalAliasTotal: 7 },
    };
    writeJson(operationReceiptPath, operationReceipt);
    Object.assign(fixture, { cases, events, acceptedRun, manifest, operationReceipt, productFiles, initialProbe, finalProbe, pre, mid, post });
    return fixture;
}

function rewriteAccepted(fixture, { observations, events } = {}) {
    if (observations) {
        fixture.cases = observations;
        writeJson(path.join(fixture.acceptedDir, 'observations.json'), observations);
    }
    if (events) {
        rehashEventChain(events);
        fixture.events = events;
        writeFile(path.join(fixture.acceptedDir, 'runner-events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    }
    fixture.manifest = sealAccepted(fixture);
}

function rewriteProbeAuthority(fixture, phase, mutate) {
    const operation = readJson(fixture.operationReceiptPath);
    const key = phase === 'initial' ? 'initial' : 'finalAlias';
    const relativePath = operation.fileProbes[`${key}Path`];
    const probePath = path.join(fixture.acceptedDir, relativePath);
    const probe = readJson(probePath);
    mutate(probe);
    writeJson(probePath, probe);
    operation.fileProbes[`${key}Sha256`] = sha256File(probePath);
    fixture.manifest = sealAccepted(fixture);
    operation.accepted.manifestSha256 = sha256File(path.join(fixture.acceptedDir, 'artifact-manifest.json'));
    operation.accepted.treeDigest = sha256(canonicalJson({ files: fixture.manifest.files, manifestSha256: operation.accepted.manifestSha256 }));
    writeJson(fixture.operationReceiptPath, operation);
}

function rewriteCampaign(fixture, claims) {
    writeJson(path.join(fixture.campaignDir, 'claims.json'), claims);
    const envelopePath = path.join(fixture.campaignDir, 'submission-envelope.json');
    const envelope = readJson(envelopePath);
    envelope.payloadHashes['claims.json'] = sha256File(path.join(fixture.campaignDir, 'claims.json'));
    writeJson(envelopePath, envelope);
    const receipt = readJson(fixture.campaignReceiptPath);
    receipt.campaign.submissionEnvelopeSha256 = sha256File(envelopePath);
    writeJson(fixture.campaignReceiptPath, receipt);
}

function mutateScreenshot(fixture, destinationIndex, sourceIndex, mode) {
    const observations = structuredClone(fixture.cases);
    const flat = observations.flatMap((record) => record.screenshots.map((screenshot) => ({ record, screenshot })));
    const destination = flat[destinationIndex].screenshot;
    const source = flat[sourceIndex].screenshot;
    const destinationFile = path.join(fixture.acceptedDir, destination.relativePath);
    const sourceFile = path.join(fixture.acceptedDir, source.relativePath);
    const destinationBytes = fs.readFileSync(destinationFile);
    const sourceBytes = fs.readFileSync(sourceFile);
    writeFile(destinationFile, sourceBytes);
    destination.bytes = sourceBytes.length;
    destination.sha256 = sha256(sourceBytes);
    if (mode === 'swap-bytes') {
        writeFile(sourceFile, destinationBytes);
        source.bytes = destinationBytes.length;
        source.sha256 = sha256(destinationBytes);
        [destination.oracleSnapshotSha256, source.oracleSnapshotSha256] = [source.oracleSnapshotSha256, destination.oracleSnapshotSha256];
    } else destination.oracleSnapshotSha256 = source.oracleSnapshotSha256;
    const events = buildEvents(observations);
    rewriteAccepted(fixture, { observations, events });
}

function getAt(root, pathParts) {
    return pathParts.reduce((value, key) => value[key], root);
}

function setAt(root, pathParts, value) {
    const parent = getAt(root, pathParts.slice(0, -1));
    parent[pathParts.at(-1)] = value;
}

function objectPaths(root) {
    const result = [];
    const shapes = new Set();
    function walk(value, pathParts) {
        if (Array.isArray(value)) {
            if (value.length > 0) walk(value[0], [...pathParts, 0]);
            return;
        }
        if (!value || typeof value !== 'object') return;
        const shape = Object.keys(value).sort().join('|');
        if (!shapes.has(shape)) {
            shapes.add(shape);
            result.push(pathParts);
        }
        for (const [key, child] of Object.entries(value)) walk(child, [...pathParts, key]);
    }
    walk(root, []);
    return result;
}

function wrongType(value) {
    if (Array.isArray(value)) return {};
    if (value === null) return 'unexpected-signal';
    if (typeof value === 'string') return 7;
    if (typeof value === 'number') return '7';
    if (typeof value === 'boolean') return 1;
    if (typeof value === 'object') return [];
    return null;
}

function assertRecursiveSchema(validator, valid, name) {
    for (const objectPath of objectPaths(valid)) {
        const originalObject = getAt(valid, objectPath);
        const unknown = structuredClone(valid);
        getAt(unknown, objectPath).__unknown = true;
        assert.throws(() => validator(unknown), undefined, `${name} rejects unknown at ${objectPath.join('.') || '<root>'}`);
        for (const key of Object.keys(originalObject)) {
            const missing = structuredClone(valid);
            delete getAt(missing, objectPath)[key];
            assert.throws(() => validator(missing), undefined, `${name} rejects missing ${[...objectPath, key].join('.')}`);
            const typed = structuredClone(valid);
            setAt(typed, [...objectPath, key], wrongType(originalObject[key]));
            assert.throws(() => validator(typed), undefined, `${name} rejects wrong type ${[...objectPath, key].join('.')}`);
        }
    }
}

function expectedAuditReceipt(fixture) {
    return {
        schemaVersion: 1, releaseId: RELEASE_ID, status: 'VERIFIED', createdUtc: utcAt(120_000), auditedTargetRealpath: fs.realpathSync(fixture.acceptedDir),
        configSha256: sha256File(fixture.configPath), operationReceiptSha256: sha256File(fixture.operationReceiptPath),
        acceptedManifestSha256: sha256File(path.join(fixture.acceptedDir, 'artifact-manifest.json')),
        eventsSha256: sha256File(path.join(fixture.acceptedDir, 'runner-events.jsonl')), finalEventSha256: fixture.events.at(-1).eventSha256,
        deploymentId: DEPLOYMENT_ID, passedCases: 6, totalCases: 6, controlPlaneReads: 3,
        initialFileGate: { passed: 14, total: 14 }, finalAliasGate: { passed: 7, total: 7 }, screenshotBindings: fixture.operationReceipt.screenshotBindings,
    };
}

test('record without operator receipt is not deployment authority', (t) => {
    const fixture = createAcceptedFixture(t);
    const config = {
        ...fixture.config,
        accountId: ACCOUNT_ID,
        sourceGitTree: SOURCE_TREE,
        deploymentOperatorReceiptPath: path.join(fixture.releaseRoot, 'missing-operator-receipt.json'),
    };
    assert.throws(() => smoke.loadOperationAuthority(config), /deploymentOperatorReceipt/);
});

test('operator receipt record binding rejects a mismatched record hash', (t) => {
    const fixture = createAcceptedFixture(t);
    const deploymentOperatorReceiptPath = path.join(fixture.releaseRoot, 'operator-deployment-receipt.json');
    writeJson(deploymentOperatorReceiptPath, {
        schemaVersion: 1,
        operation: 'deploy',
        releaseId: fixture.config.releaseId,
        campaignRunId: fixture.config.campaignRunId,
        projectName: fixture.config.projectName,
        accountId: ACCOUNT_ID,
        environment: 'Production',
        branch: 'main',
        sourceGitHead: SOURCE_HEAD,
        sourceGitTree: SOURCE_TREE,
        deploymentRecordPath: fixture.deploymentRecordPath,
        deploymentRecordBytes: fs.statSync(fixture.deploymentRecordPath).size,
        deploymentRecordSha256: '0'.repeat(64),
        deploymentId: DEPLOYMENT_ID,
        immutableUrl: IMMUTABLE_URL,
        aliasUrl: ALIAS_URL,
        createdUtc: utcAt(-50),
    });
    const config = { ...fixture.config, deploymentOperatorReceiptPath };
    assert.throws(() => smoke.loadOperationAuthority(config), /deploymentOperatorReceipt\.deploymentRecord/);
});

test('INDETERMINATE residue cannot become deployment authority', (t) => {
    const fixture = createAcceptedFixture(t);
    fs.unlinkSync(fixture.deploymentOperatorReceiptPath);
    assert.throws(() => smoke.auditAcceptedRun({ configPath: fixture.configPath }), /deploymentOperatorReceipt/);
});

test('a complete accepted fixture authenticates every external authority and all 518 events end to end', (t) => {
    const fixture = createAcceptedFixture(t);
    const receipt = smoke.auditAcceptedRun({ configPath: fixture.configPath });
    assert.equal(receipt.status, 'VERIFIED');
    assert.equal(receipt.passedCases, 6);
    assert.equal(receipt.screenshotBindings.length, 18);
    assert.equal(receipt.finalEventSha256, fixture.events.at(-1).eventSha256);
    assert.equal(fixture.events.length, 518);
    assert.equal(fixture.cases.every((record) => record.actions.length === 78), true);
    const duplicateA = fixture.cases[1].screenshots[1];
    const duplicateB = fixture.cases[2].screenshots[1];
    assert.equal(duplicateA.sha256, duplicateB.sha256, 'equal PNG hashes are valid for distinct tuples');

    const cli = spawnSync(process.execPath, [path.resolve('scripts/verify-public-smoke-v2.mjs'), '--config', fixture.configPath], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stderr, '');
    assert.equal(cli.stdout, `PUBLIC_SMOKE_V2_GATE=6/6 manifest_sha256=${receipt.acceptedManifestSha256} release=${RELEASE_ID}\n`);
    const emitted = readJson(fixture.config.auditReceiptPath);
    smoke.validateAuditReceipt(emitted, expectedAuditReceipt(fixture));
    const rebound = structuredClone(receipt);
    rebound.deploymentId = 'feedface-1234-5678-9abc-def012345678';
    assert.throws(() => smoke.validateAuditReceipt(rebound, receipt), /auditReceipt\.binding/);
    const before = sha256File(fixture.config.auditReceiptPath);
    const repeated = spawnSync(process.execPath, [path.resolve('scripts/verify-public-smoke-v2.mjs'), '--config', fixture.configPath], { encoding: 'utf8' });
    assert.notEqual(repeated.status, 0);
    assert.equal(repeated.stdout.includes('PUBLIC_SMOKE_V2_GATE='), false);
    assert.equal(sha256File(fixture.config.auditReceiptPath), before, 'exclusive creation never overwrites the receipt');
});

test('invalid auditor input emits no gate and creates no receipt', (t) => {
    const fixture = createAcceptedFixture(t);
    const config = readJson(fixture.configPath);
    config.unknown = true;
    writeJson(fixture.configPath, config);
    const cli = spawnSync(process.execPath, [path.resolve('scripts/verify-public-smoke-v2.mjs'), '--config', fixture.configPath], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0);
    assert.equal(cli.stdout.includes('PUBLIC_SMOKE_V2_GATE='), false);
    assert.equal(fs.existsSync(fixture.config.auditReceiptPath), false);
});

test('raw Content-Type is authoritative after every downstream hash is resealed', (t) => {
    for (const [name, publicPath, contentType] of [
        ['wrong text type', '/', 'text/plain'],
        ['empty', '/', ''],
        ['whitespace', '/', '   '],
        ['JavaScript binary fallback', '/script.js', 'application/octet-stream'],
        ['semicolon only', '/', '; charset=utf-8'],
    ]) {
        const fixture = createAcceptedFixture(t);
        rewriteProbeAuthority(fixture, 'initial', (probe) => {
            probe.results.find((result) => result.path === publicPath).contentType = contentType;
        });
        assert.throws(() => smoke.auditAcceptedRun({ configPath: fixture.configPath }), /fileGate\.initial\.mime/, name);
    }

    for (const [publicPath, contentType] of [
        ['/', ' text/html '],
        ['/', 'text/html; charset=utf-8; boundary=x'],
        ['/script.js', ' Application/JavaScript ; charset=UTF-8'],
        ['/style.css', ' Text/CSS ; charset=UTF-8'],
    ]) {
        const fixture = createAcceptedFixture(t);
        rewriteProbeAuthority(fixture, 'initial', (probe) => {
            probe.results.find((result) => result.path === publicPath).contentType = contentType;
        });
        assert.doesNotThrow(() => smoke.auditAcceptedRun({ configPath: fixture.configPath }), `${publicPath} ${contentType}`);
    }

    const claimed = createAcceptedFixture(t);
    rewriteProbeAuthority(claimed, 'finalAlias', (probe) => {
        probe.results.find((result) => result.path === '/script.js').mime = 'text/plain';
    });
    assert.throws(() => smoke.auditAcceptedRun({ configPath: claimed.configPath }), /fileGate\.finalAlias\.mime/);
});

test('receipt validation failure happens before publication and leaves no final receipt', (t) => {
    const fixture = createAcceptedFixture(t);
    const tools = path.join(fixture.temp, 'fault-tools');
    fs.mkdirSync(tools);
    const library = fs.readFileSync(path.resolve('scripts/public-smoke-v2-lib.mjs'), 'utf8').replace(
        'export function validateAuditReceipt(receipt, expected) {',
        "export function validateAuditReceipt(receipt, expected) { if (expected !== undefined) throw new Error('injected receipt validation failure');",
    );
    fs.writeFileSync(path.join(tools, 'public-smoke-v2-lib.mjs'), library);
    fs.copyFileSync(path.resolve('scripts/verify-public-smoke-v2.mjs'), path.join(tools, 'verify-public-smoke-v2.mjs'));
    const cli = spawnSync(process.execPath, [path.join(tools, 'verify-public-smoke-v2.mjs'), '--config', fixture.configPath], {
        encoding: 'utf8',
        timeout: 15_000,
    });
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /injected receipt validation failure/);
    assert.equal(cli.stdout.includes('PUBLIC_SMOKE_V2_GATE='), false);
    assert.equal(fs.existsSync(fixture.config.auditReceiptPath), false);
});

test('validated receipt publication creates a missing contained parent directory', (t) => {
    const fixture = createAcceptedFixture(t);
    const config = readJson(fixture.configPath);
    config.auditReceiptPath = path.join(fixture.releaseRoot, 'missing', 'nested', 'audit-receipt.json');
    writeJson(fixture.configPath, config);
    const operation = readJson(fixture.operationReceiptPath);
    operation.configSha256 = sha256File(fixture.configPath);
    writeJson(fixture.operationReceiptPath, operation);
    const cli = spawnSync(process.execPath, [path.resolve('scripts/verify-public-smoke-v2.mjs'), '--config', fixture.configPath], {
        encoding: 'utf8',
        timeout: 15_000,
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /^PUBLIC_SMOKE_V2_GATE=6\/6 /);
    assert.equal(fs.existsSync(config.auditReceiptPath), true);
});

test('case deadline is measured from that case context creation rather than the operation clock origin', (t) => {
    const fixture = createAcceptedFixture(t);
    const record = structuredClone(fixture.cases[0]);
    record.startedMonotonicMs = 200_000;
    record.finishedMonotonicMs = 201_000;
    assert.doesNotThrow(() => smoke.validateCase(record));

    record.finishedMonotonicMs = 320_000;
    assert.throws(() => smoke.validateCase(record), /case\.duration/);
});

test('security-sensitive external and audit schemas are recursively exact', (t) => {
    const fixture = createAcceptedFixture(t);
    const claims = readJson(path.join(fixture.campaignDir, 'claims.json'));
    const envelope = readJson(path.join(fixture.campaignDir, 'submission-envelope.json'));
    const campaignReceipt = readJson(fixture.campaignReceiptPath);
    const operationReceipt = readJson(fixture.operationReceiptPath);
    const derived = {
        schemaVersion: 3, baseConfigPath: fixture.configPath, baseConfigSha256: sha256File(fixture.configPath), mutationId: 'NC-FIXTURE',
        mutationRootRealpath: path.join(fixture.temp, 'mutation'), auditTargetRealpath: path.join(fixture.temp, 'mutation', 'accepted'),
        externalOperationReceiptPath: fixture.operationReceiptPath, auditReceiptPath: path.join(fixture.temp, 'mutation', 'audit.json'),
    };
    assertRecursiveSchema(smoke.validateOperationConfig, fixture.config, 'operation config');
    assertRecursiveSchema(smoke.validateDerivedAuditConfig, derived, 'derived audit config');
    assertRecursiveSchema(smoke.validateCampaignClaims, claims, 'campaign claims');
    assertRecursiveSchema(smoke.validateCampaignEnvelope, envelope, 'campaign envelope');
    assertRecursiveSchema(smoke.validateCampaignReceipt, campaignReceipt, 'campaign receipt');
    assertRecursiveSchema(smoke.validateOperationReceipt, operationReceipt, 'operation receipt');
    assertRecursiveSchema(smoke.validateAuditReceipt, expectedAuditReceipt(fixture), 'audit receipt');
    assertRecursiveSchema(smoke.validateCase, fixture.cases[0], 'case record');
});

test('derived schema-3 audit selects only its contained copied target and exclusive receipt', (t) => {
    const fixture = createAcceptedFixture(t);
    const mutationRoot = path.join(fixture.temp, 'mutation-root');
    const target = path.join(mutationRoot, 'accepted');
    fs.mkdirSync(mutationRoot);
    fs.cpSync(fixture.acceptedDir, target, { recursive: true });
    const auditReceiptPath = path.join(mutationRoot, 'audit-receipt.json');
    const derivedPath = path.join(mutationRoot, 'audit-config.json');
    const derived = {
        schemaVersion: 3, baseConfigPath: fixture.configPath, baseConfigSha256: sha256File(fixture.configPath), mutationId: 'NC-FIXTURE',
        mutationRootRealpath: fs.realpathSync(mutationRoot), auditTargetRealpath: fs.realpathSync(target), externalOperationReceiptPath: fixture.operationReceiptPath, auditReceiptPath,
    };
    writeJson(derivedPath, derived);
    const cli = spawnSync(process.execPath, [path.resolve('scripts/verify-public-smoke-v2.mjs'), '--config', derivedPath], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stderr, `AUDIT_TARGET_REALPATH=${fs.realpathSync(target)}\n`);
    assert.match(cli.stdout, /^PUBLIC_SMOKE_V2_GATE=6\/6 /);
    const receipt = readJson(auditReceiptPath);
    assert.equal(receipt.auditedTargetRealpath, fs.realpathSync(target));
    assert.equal(receipt.configSha256, sha256File(derivedPath));
    assert.notEqual(receipt.auditedTargetRealpath, fs.realpathSync(fixture.acceptedDir));
});

test('full-rehash semantic mutations fail at their stable invariant before frozen receipt hashes', (t) => {
    const table = [
        ['campaign verifier capture', /campaignVerifier\.gateLine/, (fixture) => {
            const operation = readJson(fixture.operationReceiptPath);
            const stdout = Buffer.from('NO_GO\n');
            writeFile(operation.campaignVerifier.stdoutPath, stdout);
            operation.campaignVerifier.stdoutBytes = stdout.length;
            operation.campaignVerifier.stdoutSha256 = sha256(stdout);
            operation.campaignVerifier.gateLine = 'NO_GO';
            writeJson(fixture.operationReceiptPath, operation);
        }],
        ['worker capture', /worker\.stderr/, (fixture) => {
            const operation = readJson(fixture.operationReceiptPath);
            const stderr = Buffer.from('worker error\n');
            writeFile(operation.worker.stderrPath, stderr);
            operation.worker.stderrBytes = stderr.length;
            operation.worker.stderrSha256 = sha256(stderr);
            writeJson(fixture.operationReceiptPath, operation);
        }],
        ['operation accepted manifest binding', /manifest\.operationReceiptBinding/, (fixture) => {
            const operation = readJson(fixture.operationReceiptPath);
            operation.accepted.manifestSha256 = '0'.repeat(64);
            writeJson(fixture.operationReceiptPath, operation);
        }],
        ['control plane external authority', /cloudflare\.preDeploymentId/, (fixture) => {
            const stdoutFile = path.join(fixture.acceptedDir, 'control-plane/pre.stdout.bin');
            const rows = JSON.parse(fs.readFileSync(stdoutFile, 'utf8'));
            rows[0].Id = 'feedface-1234-5678-9abc-def012345678';
            const bytes = Buffer.from(`${JSON.stringify(rows)}\n`);
            writeFile(stdoutFile, bytes);
            const captureFile = path.join(fixture.acceptedDir, 'control-plane/pre.command.json');
            const capture = readJson(captureFile);
            capture.stdoutBytes = bytes.length;
            capture.stdoutSha256 = sha256(bytes);
            writeJson(captureFile, capture);
            rewriteAccepted(fixture);
        }],
        ['control plane recursive schema', /cloudflare\.mid\.capture/, (fixture) => {
            const captureFile = path.join(fixture.acceptedDir, 'control-plane/mid.command.json');
            const capture = readJson(captureFile);
            capture.attacker = true;
            writeJson(captureFile, capture);
            rewriteAccepted(fixture);
        }],
        ['file probe source authority', /fileGate\.finalAlias\.scriptSha256/, (fixture) => {
            const probeFile = path.join(fixture.acceptedDir, 'file-probes/final-alias-5.json');
            const probe = readJson(probeFile);
            probe.results.find((result) => result.path === '/script.js').sha256 = 'f'.repeat(64);
            writeJson(probeFile, probe);
            rewriteAccepted(fixture);
        }],
        ['file probe recursive schema', /fileGate\.initial\.result/, (fixture) => {
            const probeFile = path.join(fixture.acceptedDir, 'file-probes/initial-10.json');
            const probe = readJson(probeFile);
            delete probe.results[0].contentType;
            writeJson(probeFile, probe);
            rewriteAccepted(fixture);
        }],
        ['file probe cardinality', /fileGate\.initial\.cardinality/, (fixture) => {
            const probeFile = path.join(fixture.acceptedDir, 'file-probes/initial-10.json');
            const probe = readJson(probeFile);
            probe.results.pop();
            probe.passed = 9;
            probe.total = 9;
            writeJson(probeFile, probe);
            rewriteAccepted(fixture);
        }],
        ['visibility position', /ending\.computedVisibility/, (fixture) => {
            const observations = structuredClone(fixture.cases);
            observations[0].ending.visibility.position = 'static';
            rewriteAccepted(fixture, { observations });
        }],
        ['initial visibility position', /initial\.ending/, (fixture) => {
            const observations = structuredClone(fixture.cases);
            observations[0].initial.endingVisibility.position = 'static';
            rewriteAccepted(fixture, { observations });
        }],
        ['RECOVER final delta', /recover\.starDelta/, (fixture) => {
            const observations = structuredClone(fixture.cases);
            observations[0].recoveries[46].starDelta = 150;
            rewriteAccepted(fixture, { observations });
        }],
        ['intrusion sequence', /intrusion\.sequence/, (fixture) => {
            const observations = structuredClone(fixture.cases);
            observations[0].intrusions[1].type = 'copilot';
            rewriteAccepted(fixture, { observations });
        }],
        ['action contract', /actions\.contract/, (fixture) => {
            const observations = structuredClone(fixture.cases);
            observations[0].actions[5].target = '#btn-revert';
            rewriteAccepted(fixture, { observations });
        }],
        ['action cardinality', /actions\.cardinality/, (fixture) => {
            const observations = structuredClone(fixture.cases);
            observations[0].actions.pop();
            rewriteAccepted(fixture, { observations });
        }],
        ['failed request', /errors\.requestFailed/, (fixture) => {
            const observations = structuredClone(fixture.cases);
            observations[0].errors.requestFailed.push({ url: `${IMMUTABLE_URL}script.js`, method: 'GET', errorText: 'net::ERR_FAILED' });
            rewriteAccepted(fixture, { observations });
        }],
        ['console error', /errors\.console/, (fixture) => {
            const observations = structuredClone(fixture.cases);
            observations[0].errors.console.push({ type: 'error', text: 'fixture error' });
            rewriteAccepted(fixture, { observations });
        }],
        ['page error', /errors\.page/, (fixture) => {
            const observations = structuredClone(fixture.cases);
            observations[0].errors.page.push({ name: 'Error', message: 'fixture error', stack: 'fixture stack' });
            rewriteAccepted(fixture, { observations });
        }],
        ['HTTP error', /errors\.http/, (fixture) => {
            const observations = structuredClone(fixture.cases);
            observations[0].errors.http.push({ url: `${IMMUTABLE_URL}script.js`, status: 500 });
            rewriteAccepted(fixture, { observations });
        }],
        ['cross-origin request', /errors\.external/, (fixture) => {
            const observations = structuredClone(fixture.cases);
            observations[0].errors.external.push({ url: 'https://evil.example/x.js', method: 'GET' });
            rewriteAccepted(fixture, { observations });
        }],
        ['source deployment commit mismatch', /campaign\.deployment\.sourceGitHead/, (fixture) => {
            const deployment = readJson(fixture.deploymentRecordPath);
            deployment.sourceGitHead = 'd'.repeat(40);
            writeJson(fixture.deploymentRecordPath, deployment);
        }],
        ['source deployment product mismatch', /campaign\.deployment\.productFiles/, (fixture) => {
            writeFile(path.join(fixture.sourceSnapshot, 'script.js'), 'export const fixtureScript = "mutated";\n');
            const inventory = walkInventory(fixture.sourceSnapshot);
            writeJson(path.join(fixture.campaignDir, 'candidate-inventory.json'), inventory);
            const claims = readJson(path.join(fixture.campaignDir, 'claims.json'));
            claims.candidateInventory = { fileCount: inventory.fileCount, pathListSha256: inventory.pathListSha256, contentRecordsSha256: inventory.contentRecordsSha256 };
            writeJson(path.join(fixture.campaignDir, 'claims.json'), claims);
            const envelopePath = path.join(fixture.campaignDir, 'submission-envelope.json');
            const envelope = readJson(envelopePath);
            Object.assign(envelope.source, claims.candidateInventory);
            envelope.payloadHashes['candidate-inventory.json'] = sha256File(path.join(fixture.campaignDir, 'candidate-inventory.json'));
            envelope.payloadHashes['claims.json'] = sha256File(path.join(fixture.campaignDir, 'claims.json'));
            writeJson(envelopePath, envelope);
            const receipt = readJson(fixture.campaignReceiptPath);
            receipt.candidateInventory = claims.candidateInventory;
            receipt.campaign.submissionEnvelopeSha256 = sha256File(envelopePath);
            writeJson(fixture.campaignReceiptPath, receipt);
        }],
        ['campaign claims nested meaning', /campaignClaims\.browser\.chromium/, (fixture) => {
            const claims = readJson(path.join(fixture.campaignDir, 'claims.json'));
            claims.browser.chromium.passed = 15;
            rewriteCampaign(fixture, claims);
        }],
        ['accepted run recursive schema', /acceptedRun/, (fixture) => {
            const acceptedFile = path.join(fixture.acceptedDir, 'accepted-run.json');
            const accepted = readJson(acceptedFile);
            accepted.tooling.runner.attacker = true;
            writeJson(acceptedFile, accepted);
            rewriteAccepted(fixture);
        }],
        ['accepted run source authority', /acceptedRun\.productFiles/, (fixture) => {
            const acceptedFile = path.join(fixture.acceptedDir, 'accepted-run.json');
            const accepted = readJson(acceptedFile);
            accepted.productFiles['/script.js'].sha256 = '0'.repeat(64);
            writeJson(acceptedFile, accepted);
            rewriteAccepted(fixture);
        }],
    ];
    for (const [name, expected, mutate] of table) {
        const fixture = createAcceptedFixture(t);
        mutate(fixture);
        assert.throws(() => smoke.auditAcceptedRun({ configPath: fixture.configPath }), expected, name);
    }
});

test('event-chain sequence, hash, type, counts, and ledger bindings are independently enforced', (t) => {
    const table = [
        ['count', /events\.cardinality/, (events) => events.pop()],
        ['type', /events\.type/, (events) => { events[10].type = 'attacker-event'; }],
        ['ledger payload', /events\.actionBinding/, (events) => { events.find((event) => event.type === 'trusted-input').payload.target = '#attacker'; }],
    ];
    for (const [name, expected, mutate] of table) {
        const fixture = createAcceptedFixture(t);
        const events = structuredClone(fixture.events);
        mutate(events);
        rewriteAccepted(fixture, { events });
        assert.throws(() => smoke.auditAcceptedRun({ configPath: fixture.configPath }), expected, name);
    }
    {
        const fixture = createAcceptedFixture(t);
        const events = structuredClone(fixture.events);
        events[20].eventSha256 = 'f'.repeat(64);
        writeFile(path.join(fixture.acceptedDir, 'runner-events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
        rewriteAccepted(fixture);
        assert.throws(() => smoke.auditAcceptedRun({ configPath: fixture.configPath }), /events\.hash/);
    }
});

test('PNG signature, IHDR viewport, tuple path, oracle and time bindings are all enforced', (t) => {
    const table = [
        ['malformed signature', /png\.signature|png\.structure/, (fixture, screenshot, file) => writeFile(file, Buffer.from('not a png'))],
        ['wrong IHDR viewport', /png\.viewport/, (fixture, screenshot, file) => writeFile(file, png(321, 640, 'wrong-width'))],
        ['path tuple', /screenshot\.path/, (fixture, screenshot) => { screenshot.relativePath = 'screenshots/wrong.png'; }],
        ['oracle', /screenshot\.operationReceiptBinding/, (fixture, screenshot) => { screenshot.oracleSnapshotSha256 = 'e'.repeat(64); }],
        ['timestamp order', /screenshot\.timestamps/, (fixture, screenshot) => { screenshot.captureFinishedUtc = screenshot.captureStartedUtc; }],
    ];
    for (const [name, expected, mutate] of table) {
        const fixture = createAcceptedFixture(t);
        const observations = structuredClone(fixture.cases);
        const screenshot = observations[0].screenshots[0];
        const file = path.join(fixture.acceptedDir, screenshot.relativePath);
        mutate(fixture, screenshot, file);
        if (fs.existsSync(file)) {
            const bytes = fs.readFileSync(file);
            screenshot.bytes = bytes.length;
            screenshot.sha256 = sha256(bytes);
        }
        const events = buildEvents(observations);
        rewriteAccepted(fixture, { observations, events });
        assert.throws(() => smoke.auditAcceptedRun({ configPath: fixture.configPath }), expected, name);
    }
});

test('rehashed screenshot swap and copy reach the frozen operation-receipt binding', (t) => {
    for (const [name, destination, source, mode] of [
        ['swap', 0, 15, 'swap-bytes'],
        ['copy', 4, 10, 'copy-binding'],
    ]) {
        const fixture = createAcceptedFixture(t);
        mutateScreenshot(fixture, destination, source, mode);
        assert.throws(() => smoke.auditAcceptedRun({ configPath: fixture.configPath }), /screenshot\.operationReceiptBinding/, name);
    }
});

test('config and manifest containment reject escapes, case collisions, and symlink ancestors', (t) => {
    {
        const fixture = createAcceptedFixture(t);
        const config = readJson(fixture.configPath);
        config.auditReceiptPath = path.join(fixture.temp, 'escaped-audit.json');
        writeJson(fixture.configPath, config);
        const operation = readJson(fixture.operationReceiptPath);
        operation.configSha256 = sha256File(fixture.configPath);
        writeJson(fixture.operationReceiptPath, operation);
        assert.throws(() => smoke.auditAcceptedRun({ configPath: fixture.configPath }), /config\.auditReceiptPath\.containment/);
    }
    {
        const fixture = createAcceptedFixture(t);
        const target = path.join(fixture.acceptedDir, 'file-probes/bodies/initial-alias-script-js.bin');
        const external = path.join(fixture.temp, 'external.bin');
        writeFile(external, fs.readFileSync(target));
        fs.rmSync(target);
        fs.symlinkSync(external, target);
        assert.throws(() => smoke.auditAcceptedRun({ configPath: fixture.configPath }), /symlink/);
    }
    {
        const root = tempRoot(t);
        writeFile(path.join(root, 'A.bin'), 'a');
        const manifest = manifestFor(root);
        manifest.files.push({ ...manifest.files[0], path: 'a.bin' });
        manifest.manifestPayloadSha256 = sha256(canonicalJson({ schemaVersion: manifest.schemaVersion, releaseId: manifest.releaseId, files: manifest.files }));
        assert.throws(() => validateManifest(root, manifest), /case.*collision/i);
    }
});

test('accepted manifest rejects rehashed unexpected and missing members', (t) => {
    const fixture = createAcceptedFixture(t);
    writeFile(path.join(fixture.acceptedDir, 'unexpected.bin'), 'attacker bytes');
    rewriteAccepted(fixture);
    assert.throws(() => smoke.auditAcceptedRun({ configPath: fixture.configPath }), /manifest\.acceptedFileSet/);

    const missing = createAcceptedFixture(t);
    const manifestPath = path.join(missing.acceptedDir, 'artifact-manifest.json');
    const manifest = readJson(manifestPath);
    manifest.files = manifest.files.filter((entry) => entry.path !== 'control-plane/post.stderr.bin');
    manifest.manifestPayloadSha256 = sha256(canonicalJson({ schemaVersion: manifest.schemaVersion, releaseId: manifest.releaseId, files: manifest.files }));
    writeJson(manifestPath, manifest);
    assert.throws(() => smoke.auditAcceptedRun({ configPath: missing.configPath }), /manifest\.fileSet/);
});

test('audit receipt semantics reject every fixed count, digest, target, deployment and screenshot mutation', (t) => {
    const fixture = createAcceptedFixture(t);
    const valid = expectedAuditReceipt(fixture);
    const mutations = [
        ['status', (value) => { value.status = 'FAILED'; }],
        ['passedCases', (value) => { value.passedCases = 5; }],
        ['totalCases', (value) => { value.totalCases = 7; }],
        ['controlPlaneReads', (value) => { value.controlPlaneReads = 2; }],
        ['initialFileGate', (value) => { value.initialFileGate.passed = 9; }],
        ['finalAliasGate', (value) => { value.finalAliasGate.total = 6; }],
        ['target', (value) => { value.auditedTargetRealpath = fixture.releaseRoot; }],
        ['config', (value) => { value.configSha256 = '0'.repeat(64); }],
        ['operation', (value) => { value.operationReceiptSha256 = '0'.repeat(64); }],
        ['manifest', (value) => { value.acceptedManifestSha256 = '0'.repeat(64); }],
        ['events', (value) => { value.eventsSha256 = '0'.repeat(64); }],
        ['final event', (value) => { value.finalEventSha256 = '0'.repeat(64); }],
        ['deployment', (value) => { value.deploymentId = 'feedface-1234-5678-9abc-def012345678'; }],
        ['screenshot count', (value) => { value.screenshotBindings.pop(); }],
        ['screenshot binding', (value) => { value.screenshotBindings[0].oracleSha256 = '0'.repeat(64); }],
    ];
    assert.doesNotThrow(() => smoke.validateAuditReceipt(valid, valid));
    for (const [name, mutate] of mutations) {
        const changed = structuredClone(valid);
        mutate(changed);
        assert.throws(() => smoke.validateAuditReceipt(changed, valid), /auditReceipt/, name);
    }
});
