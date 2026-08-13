import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SMOKE_SCHEMA_VERSION = 2;
export const ENGINES = Object.freeze(['chromium', 'firefox', 'webkit']);
export const ORIGINS = Object.freeze(['immutable', 'alias']);
export const STAGES = Object.freeze(['initial', 'progress', 'ending']);

const PRODUCT_PATHS = Object.freeze(['/', '/content.js', '/game-core.js', '/script.js', '/style.css']);
const RELEASE_ID = /^[0-9]{8}T[0-9]{6}Z-r14-public-smoke-v2$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ZERO_SHA256 = '0'.repeat(64);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fail(invariant, detail = '') {
    throw new Error(`${invariant}${detail ? `: ${detail}` : ''}`);
}

function object(value, invariant) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(invariant, 'must be an object');
    return value;
}

function exactKeys(value, keys, invariant) {
    const actual = Object.keys(object(value, invariant)).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(invariant, `keys=${actual.join(',')}`);
    return value;
}

function string(value, invariant) {
    if (typeof value !== 'string') fail(invariant, 'must be a string');
    return value;
}

function integer(value, invariant) {
    if (!Number.isSafeInteger(value)) fail(invariant, 'must be a safe integer');
    return value;
}

function nonNegative(value, invariant) {
    if (integer(value, invariant) < 0) fail(invariant, 'must be non-negative');
    return value;
}

function bool(value, invariant) {
    if (typeof value !== 'boolean') fail(invariant, 'must be boolean');
    return value;
}

function sha(value, invariant) {
    if (!SHA256.test(string(value, invariant))) fail(invariant, 'must be 64 lowercase hex');
    return value;
}

function utc(value, invariant) {
    if (!Number.isFinite(Date.parse(string(value, invariant)))) fail(invariant, 'must be UTC date');
    return value;
}

function sameArray(actual, expected, invariant) {
    if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) fail(invariant);
}

function relativeFile(value, invariant) {
    const candidate = string(value, invariant);
    if (!candidate || path.isAbsolute(candidate) || candidate.includes('\\') || candidate.split('/').some((segment) => !segment || segment === '.' || segment === '..')) fail(invariant, 'must be a contained POSIX relative file');
    return candidate;
}

function canonicalPath(file, invariant) {
    const resolved = path.resolve(string(file, invariant));
    if (!path.isAbsolute(resolved)) fail(invariant, 'must be absolute');
    return resolved;
}

function contained(root, candidate, invariant) {
    const base = canonicalPath(root, `${invariant}.root`);
    const resolved = canonicalPath(candidate, invariant);
    if (resolved === base || !resolved.startsWith(`${base}${path.sep}`)) fail(invariant, 'escapes root');
    return resolved;
}

function realContained(root, candidate, invariant) {
    const base = fs.realpathSync(root);
    const target = fs.realpathSync(candidate);
    if (target === base || !target.startsWith(`${base}${path.sep}`)) fail(invariant, 'realpath escapes root');
    return target;
}

function noSymlinkAncestors(target, invariant) {
    let cursor = path.resolve(target);
    while (true) {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail(invariant, `symlink=${cursor}`);
        const parent = path.dirname(cursor);
        if (parent === cursor) return;
        cursor = parent;
    }
}

export function canonicalJson(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) fail('canonicalJson.number');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (!value || typeof value !== 'object') fail('canonicalJson.value');
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256File(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('file.regular', file);
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Bytes(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

export function expectedCaseLabels() {
    return ENGINES.flatMap((engine) => ORIGINS.map((origin) => `${engine}-${origin}`));
}

function expectedScreenshotName(label, stage) {
    return `${label}-${stage === 'ending' ? 'ending-640' : `${stage}-320`}.png`;
}

export function deriveVisibility(raw) {
    const primitiveKeys = ['hiddenAttribute', 'display', 'position', 'visibility', 'opacity', 'clientRects', 'intersectionArea', 'intersectionRatio', 'viewportWidth', 'viewportHeight', 'centerX', 'centerY', 'hitElementId', 'hitIsSelfOrDescendant'];
    const actualKeys = Object.keys(object(raw, 'visibility')).sort();
    const allowedKeys = [...primitiveKeys, 'visible'].sort();
    if (actualKeys.some((key) => !allowedKeys.includes(key)) || primitiveKeys.some((key) => !actualKeys.includes(key))) fail('visibility', `keys=${actualKeys.join(',')}`);
    if (bool(raw.hiddenAttribute, 'visibility.hiddenAttribute')) return false;
    if (string(raw.display, 'visibility.display') === 'none') return false;
    if (string(raw.position, 'visibility.position') !== 'fixed') return false;
    if (['hidden', 'collapse'].includes(string(raw.visibility, 'visibility.visibility'))) return false;
    if (!(typeof raw.opacity === 'number' && Number.isFinite(raw.opacity) && raw.opacity > 0)) return false;
    if (!Array.isArray(raw.clientRects) || !raw.clientRects.some((rect) => {
        exactKeys(rect, ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'], 'visibility.clientRect');
        return Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0;
    })) return false;
    for (const key of ['intersectionArea', 'intersectionRatio', 'viewportWidth', 'viewportHeight']) if (!(typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] > 0)) return false;
    if (!(typeof raw.centerX === 'number' && Number.isFinite(raw.centerX) && typeof raw.centerY === 'number' && Number.isFinite(raw.centerY))) return false;
    string(raw.hitElementId, 'visibility.hitElementId');
    return bool(raw.hitIsSelfOrDescendant, 'visibility.hitIsSelfOrDescendant');
}

function pngDimensions(file, invariant) {
    const data = fs.readFileSync(file);
    if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('ascii', 12, 16) !== 'IHDR') fail(invariant, 'invalid PNG');
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (!width || !height) fail(invariant, 'zero PNG dimensions');
    return { width, height };
}

function walkFiles(root, current = root) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        if (entry.isSymbolicLink()) fail('manifest.symlink', absolute);
        if (entry.isDirectory()) files.push(...walkFiles(root, absolute));
        else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
        else fail('manifest.regular', absolute);
    }
    return files.sort();
}

export function validateManifest(root, manifest) {
    exactKeys(manifest, ['schemaVersion', 'releaseId', 'files', 'manifestPayloadSha256'], 'manifest');
    if (manifest.schemaVersion !== 1) fail('manifest.schemaVersion');
    if (!RELEASE_ID.test(string(manifest.releaseId, 'manifest.releaseId'))) fail('manifest.releaseId');
    if (!Array.isArray(manifest.files)) fail('manifest.files');
    const files = [];
    for (const entry of manifest.files) {
        exactKeys(entry, ['path', 'bytes', 'sha256'], 'manifest.file');
        const relative = relativeFile(entry.path, 'manifest.file.path');
        nonNegative(entry.bytes, 'manifest.file.bytes');
        sha(entry.sha256, 'manifest.file.sha256');
        if (files.includes(relative)) fail('manifest.duplicate', relative);
        const absolute = contained(root, path.join(root, relative), 'manifest.file.path');
        noSymlinkAncestors(absolute, 'manifest.file.path');
        const stat = fs.lstatSync(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) fail('manifest.file.regular', relative);
        if (stat.size !== entry.bytes || sha256File(absolute) !== entry.sha256) fail('manifest.file.hash', relative);
        files.push(relative);
    }
    const expectedHash = sha256Bytes(canonicalJson({ schemaVersion: manifest.schemaVersion, releaseId: manifest.releaseId, files: manifest.files }));
    if (sha(manifest.manifestPayloadSha256, 'manifest.manifestPayloadSha256') !== expectedHash) fail('manifest.manifestPayloadSha256');
    if (fs.existsSync(root)) {
        const actual = walkFiles(root).filter((file) => file !== 'artifact-manifest.json');
        if (canonicalJson(files.sort()) !== canonicalJson(actual)) fail('manifest.fileSet');
    }
    return manifest;
}

function validateAcceptedManifest(manifest) {
    const expected = new Set(['accepted-run.json', 'observations.json', 'runner-events.jsonl']);
    for (const label of expectedCaseLabels()) for (const stage of STAGES) expected.add(`screenshots/${expectedScreenshotName(label, stage)}`);
    for (const phase of ['pre', 'mid', 'post']) for (const suffix of ['command.json', 'stdout.bin', 'stderr.bin']) expected.add(`control-plane/${phase}.${suffix}`);
    expected.add('file-probes/initial-10.json'); expected.add('file-probes/final-alias-5.json');
    for (const origin of ['initial-immutable', 'initial-alias', 'final-alias']) for (const token of ['root', 'content-js', 'game-core-js', 'script-js', 'style-css']) expected.add(`file-probes/bodies/${origin}-${token}.bin`);
    const actual = manifest.files.map((entry) => entry.path).sort();
    if (canonicalJson(actual) !== canonicalJson([...expected].sort())) fail('manifest.acceptedFileSet');
}

function validateSignature(value) {
    exactKeys(value, ['command', 'commandKind', 'system', 'systemKind', 'roast', 'roastKind', 'pseudoLabel', 'tabs'], 'signature');
    const expected = {
        command: 'archon@stone-igloo:~$ systemctl restart nginx', commandKind: 'command',
        system: 'Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.', systemKind: 'system',
        roast: '아콘 🐧 // 내 할머니도 너보단 코딩을 잘하겠다.', roastKind: 'archon', pseudoLabel: '"ARCHON // ROAST"',
    };
    for (const [key, expectedValue] of Object.entries(expected)) if (value[key] !== expectedValue) fail(`signature.${key}`);
    exactKeys(value.tabs, ['wifiAriaSelected', 'wifiTabIndex', 'cpuAriaSelected', 'cpuTabIndex', 'panelAriaLabelledby', 'terminalRowsPersisted'], 'signature.tabs');
    if (value.tabs.wifiAriaSelected !== 'false' || value.tabs.wifiTabIndex !== '-1' || value.tabs.cpuAriaSelected !== 'true' || value.tabs.cpuTabIndex !== '0' || value.tabs.panelAriaLabelledby !== 'cpu-tab' || value.tabs.terminalRowsPersisted !== true) fail('signature.tabs');
}

function validateErrors(errors) {
    exactKeys(errors, ['console', 'page', 'requestFailed', 'http', 'external'], 'errors');
    for (const key of Object.keys(errors)) if (!Array.isArray(errors[key]) || errors[key].length !== 0) fail(`errors.${key}`);
}

function expectedSnapshot(counter, serialized) {
    return { counterText: `아콘 독설 수집 ${counter}/62`, counter, serialized };
}

function validatePersistence(value) {
    exactKeys(value, ['afterBad', 'beforeReload', 'afterReload', 'afterFair'], 'quotePersistence');
    const serializedOne = '{"version":1,"cursors":{"puzzle":1,"repeat":0,"ai":0,"codeReview":0},"discovered":["puzzle:0"]}';
    const serializedTwo = '{"version":1,"cursors":{"puzzle":2,"repeat":0,"ai":0,"codeReview":0},"discovered":["puzzle:0","puzzle:1"]}';
    for (const [key, count, serialized] of [['afterBad', 1, serializedOne], ['beforeReload', 1, serializedOne], ['afterReload', 1, serializedOne], ['afterFair', 2, serializedTwo]]) {
        const snapshot = value[key];
        exactKeys(snapshot, ['counterText', 'counter', 'serialized', 'parsed'], `quotePersistence.${key}`);
        if (canonicalJson(expectedSnapshot(count, serialized)) !== canonicalJson({ counterText: snapshot.counterText, counter: snapshot.counter, serialized: snapshot.serialized })) fail('quote.reloadPersistence');
        exactKeys(snapshot.parsed, ['version', 'cursors', 'discovered'], `quotePersistence.${key}.parsed`);
        exactKeys(snapshot.parsed.cursors, ['puzzle', 'repeat', 'ai', 'codeReview'], `quotePersistence.${key}.cursors`);
        if (snapshot.parsed.version !== 1 || snapshot.parsed.cursors.puzzle !== count || snapshot.parsed.cursors.repeat !== 0 || snapshot.parsed.cursors.ai !== 0 || snapshot.parsed.cursors.codeReview !== 0 || canonicalJson(snapshot.parsed.discovered) !== canonicalJson(count === 1 ? ['puzzle:0'] : ['puzzle:0', 'puzzle:1'])) fail('quote.reloadPersistence');
    }
}

function validateActions(actions) {
    if (!Array.isArray(actions) || actions.length !== 38) fail('actions.cardinality');
    actions.forEach((action, index) => {
        exactKeys(action, ['seq', 'utc', 'monotonicMs', 'api', 'target', 'preStateSha256', 'postStateSha256', 'resultingUrl'], 'action');
        if (action.seq !== index + 1) fail('actions.sequence');
        utc(action.utc, 'action.utc'); nonNegative(action.monotonicMs, 'action.monotonicMs');
        if (!['locator.click', 'keyboard.press'].includes(action.api)) fail('actions.api');
        string(action.target, 'action.target'); sha(action.preStateSha256, 'action.preStateSha256'); sha(action.postStateSha256, 'action.postStateSha256'); string(action.resultingUrl, 'action.resultingUrl');
    });
}

const INTRUSIONS = Object.freeze([
    ['copilot', '🤖 Copilot 코드 침입!', 'Copilot이 반복되는 나쁜 코드를 생성했습니다! Esc 또는 git revert로 되돌리세요.', '아콘 🐧 // AI가 짜준 코드 복붙하다가 서버 터지면 AI가 책임지냐? 네 목통이 터지는 거다.', '페널티 수락 (-500★)'],
    ['codex', '🧠 Codex 타입 침입!', 'Codex가 변수명을 finalFinalV7로 바꿨습니다! unsafe_cast를 수정하세요.', '아콘 🐧 // 챗GPT한테 네 연봉도 대신 받아달라고 하지 그러냐?', 'Fix unsafe_cast (Esc)'],
    ['gemini', '✨ Gemini 응답 지연!', 'Gemini가 응답을 생성 중입니다... 3초 후 자동 해제되며 Esc로도 해제할 수 있습니다.', '아콘 🐧 // Copilot이 짠 코드를 리뷰도 없이 푸시(Push)해? 넌 내일부터 Copilot의 키보드 받침대다.', 'Dismiss (Esc)'],
    ['ceo', '💼 CEO 금요일 17:59 배포 지시!', 'CEO가 즉시 프로덕션 배포를 요구합니다!', '아콘 🐧 // AI 개싸움판에 낀 걸 환영한다. 근데 네가 제일 약해 보인다.', 'Reject (-500★)'],
]);

function exactState(value, invariant, expected) {
    exactKeys(value, ['units', 'stars', 'incidentCost', 'activeIntrusion'], invariant);
    for (const [key, expectedValue] of Object.entries(expected)) if (value[key] !== expectedValue) fail(invariant);
}

function validateIntrusions(value) {
    if (!Array.isArray(value) || value.length !== 4) fail('intrusion.cardinality');
    const before = [[50, 750], [100, 1000], [150, 1750], [200, 2500]];
    const after = [[50, 250, 500], [100, 1000, 500], [150, 1750, 500], [200, 2000, 1000]];
    value.forEach((intrusion, index) => {
        exactKeys(intrusion, ['ordinal', 'type', 'title', 'body', 'triggerActionSeq', 'aiQuoteText', 'aiQuoteKind', 'aiQuotesBefore', 'aiQuotesAfter', 'produceAccessibleName', 'resolutionActionSeq', 'resolutionControlName', 'before', 'after'], 'intrusion');
        const [type, title, body, quote, control] = INTRUSIONS[index];
        if (intrusion.ordinal !== index + 1 || intrusion.type !== type || intrusion.title !== title || intrusion.body !== body || intrusion.aiQuoteText !== quote || intrusion.aiQuoteKind !== 'archon' || intrusion.aiQuotesBefore !== index || intrusion.aiQuotesAfter !== index + 1 || intrusion.resolutionControlName !== control) fail('intrusion.sequence');
        integer(intrusion.triggerActionSeq, 'intrusion.triggerActionSeq'); integer(intrusion.resolutionActionSeq, 'intrusion.resolutionActionSeq');
        exactState(intrusion.before, 'intrusion.before', { units: before[index][0], stars: before[index][1], incidentCost: index === 0 ? 0 : index === 3 ? 500 : 500, activeIntrusion: type });
        exactState(intrusion.after, 'intrusion.after', { units: after[index][0], stars: after[index][1], incidentCost: after[index][2], activeIntrusion: null });
    });
}

function validatePenalty(value) {
    exactKeys(value, ['actionSeq', 'controlAccessibleName', 'before', 'after', 'starDelta'], 'penalty');
    if (value.controlAccessibleName !== '페널티 수락 (-500★)' || value.starDelta !== -500) fail('penalty.starDelta');
    integer(value.actionSeq, 'penalty.actionSeq');
    exactState(value.before, 'penalty.before', { units: 50, stars: 750, incidentCost: 0, activeIntrusion: 'copilot' });
    exactState(value.after, 'penalty.after', { units: 50, stars: 250, incidentCost: 500, activeIntrusion: null });
}

function validateRecoveries(value) {
    if (!Array.isArray(value) || value.length !== 7) fail('recoveries.cardinality');
    let stars = 2000;
    value.forEach((recovery, index) => {
        exactKeys(recovery, ['actionSeq', 'controlAccessibleName', 'before', 'after', 'starDelta'], 'recovery');
        const delta = Math.min(150, 3000 - stars);
        if (recovery.controlAccessibleName !== 'RECOVER: 생산량 변화 없이 GitHub 스타 150 복구' || recovery.starDelta !== delta) fail('recover.starDelta');
        integer(recovery.actionSeq, 'recover.actionSeq');
        exactState(recovery.before, 'recover.before', { units: 200, stars, incidentCost: 1000, activeIntrusion: null });
        stars += delta;
        exactState(recovery.after, 'recover.after', { units: 200, stars, incidentCost: 1000, activeIntrusion: null });
        if (index === 6 && delta !== 100) fail('recover.delta');
    });
}

function validateInitial(value) {
    exactKeys(value, ['endingVisibility', 'endingRole', 'endingAriaModal', 'endingAriaLabelledby', 'endingAccessibleName', 'backgroundInert', 'activeElementId', 'produceDisabled', 'produceAccessibleName'], 'initial');
    if (deriveVisibility(value.endingVisibility) || value.endingVisibility.display !== 'none' || value.endingVisibility.position !== 'fixed' || value.endingVisibility.intersectionArea !== 0 || value.endingVisibility.intersectionRatio !== 0 || value.endingVisibility.clientRects.some((rect) => rect.width > 0 && rect.height > 0) || value.endingRole !== 'dialog' || value.endingAriaModal !== 'true' || value.endingAriaLabelledby !== 'ending-process-heading' || value.endingAccessibleName !== '프로세스는 살아남았습니다' || value.activeElementId === 'btn-play-again' || value.produceDisabled !== false || value.produceAccessibleName !== '코드 작성: 생산량 10과 GitHub 스타 150 획득') fail('initial.ending');
    exactKeys(value.backgroundInert, ['header', 'dashboard', 'intrusionBanner', 'mainGrid'], 'initial.backgroundInert');
    if (Object.values(value.backgroundInert).some((inert) => inert !== false)) fail('initial.backgroundInert');
}

function validateEnding(value) {
    exactKeys(value, ['visibility', 'role', 'ariaModal', 'ariaLabelledby', 'accessibleName', 'initialFocusId', 'tabFocusId', 'shiftTabFocusId', 'backgroundInert', 'produceDisabled', 'produceAccessibleName', 'tokens'], 'ending');
    if (!deriveVisibility(value.visibility) || value.visibility.display !== 'flex' || value.visibility.position !== 'fixed') fail('ending.computedVisibility');
    if (value.role !== 'dialog' || value.ariaModal !== 'true' || value.ariaLabelledby !== 'ending-process-heading' || value.accessibleName !== '프로세스는 살아남았습니다' || value.initialFocusId !== 'btn-play-again' || value.tabFocusId !== 'btn-play-again' || value.shiftTabFocusId !== 'btn-play-again' || value.produceDisabled !== true || value.produceAccessibleName !== 'EXIT 0 달성') fail('ending.accessibility');
    exactKeys(value.backgroundInert, ['header', 'dashboard', 'intrusionBanner', 'mainGrid'], 'ending.backgroundInert');
    if (Object.values(value.backgroundInert).some((inert) => inert !== true)) fail('ending.backgroundInert');
    const requiredTokens = ['PROCESS EXIT CODE: 0', 'FINANCIAL EXIT CODE: 1', '+$3,000', '-$3,001', '-$1', '샘 알트먼의 인수 제안', 'Chief Tuna Prompt Engineer'];
    if (!Array.isArray(value.tokens) || canonicalJson(value.tokens) !== canonicalJson(requiredTokens)) fail('ending.tokens');
}

function validateCaseFull(record) {
    const keys = ['schemaVersion', 'label', 'engine', 'browserVersion', 'originKind', 'requestedUrl', 'finalUrl', 'attempt', 'startedUtc', 'finishedUtc', 'startedMonotonicMs', 'finishedMonotonicMs', 'actions', 'initial', 'signature', 'quotePersistence', 'npc', 'intrusions', 'penalty', 'recoveries', 'ending', 'errors', 'screenshots'];
    exactKeys(record, keys, 'case');
    if (record.schemaVersion !== SMOKE_SCHEMA_VERSION || !expectedCaseLabels().includes(record.label) || !ENGINES.includes(record.engine) || !ORIGINS.includes(record.originKind) || record.label !== `${record.engine}-${record.originKind}` || record.attempt !== 1) fail('case.identity');
    utc(record.startedUtc, 'case.startedUtc'); utc(record.finishedUtc, 'case.finishedUtc');
    if (Date.parse(record.finishedUtc) <= Date.parse(record.startedUtc) || nonNegative(record.finishedMonotonicMs, 'case.finishedMonotonicMs') >= 120000 || nonNegative(record.startedMonotonicMs, 'case.startedMonotonicMs') > record.finishedMonotonicMs) fail('case.duration');
    validateActions(record.actions); validateInitial(record.initial); validateSignature(record.signature); validatePersistence(record.quotePersistence); validateErrors(record.errors);
    exactKeys(record.npc, ['icon', 'name', 'message', 'visibility'], 'npc');
    if (record.npc.icon !== '🐻' || record.npc.name !== 'Polar Bear DevOps' || record.npc.message !== 'Wi-Fi는 살아났습니다. 참치 한 캔은 제 쪽에서 처리하죠.' || !deriveVisibility(record.npc.visibility)) fail('npc');
    validateIntrusions(record.intrusions); validatePenalty(record.penalty); validateRecoveries(record.recoveries); validateEnding(record.ending);
    if (!Array.isArray(record.screenshots) || record.screenshots.length !== 3) fail('screenshots.cardinality');
}

export function validateCase(record, options = {}) {
    if (options.partial === true) {
        exactKeys(record, ['signature', 'errors'], 'case.partial');
        validateSignature(record.signature); validateErrors(record.errors);
        return record;
    }
    validateCaseFull(record);
    return record;
}

function validateUrl(raw, invariant) {
    let parsed;
    try { parsed = new URL(string(raw, invariant)); } catch { fail(invariant, 'invalid URL'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') fail(invariant, 'must be clean HTTPS root URL');
    return parsed;
}

export function validateBinding(inputs) {
    exactKeys(inputs, ['releaseId', 'deploymentId', 'projectName', 'immutableUrl', 'aliasUrl', 'productFiles'], 'binding');
    if (!RELEASE_ID.test(string(inputs.releaseId, 'binding.releaseId'))) fail('binding.releaseId');
    if (!/^[a-f0-9-]{16,}$/i.test(string(inputs.deploymentId, 'binding.deploymentId'))) fail('binding.deploymentId');
    const project = string(inputs.projectName, 'binding.projectName');
    const immutable = validateUrl(inputs.immutableUrl, 'binding.immutableUrl');
    const alias = validateUrl(inputs.aliasUrl, 'binding.aliasUrl');
    if (immutable.origin === alias.origin || alias.hostname !== `${project}.pages.dev` || !new RegExp(`^[a-f0-9]{8}\\.${project.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\.pages\\.dev$`).test(immutable.hostname) || !immutable.hostname.startsWith(`${inputs.deploymentId.slice(0, 8).toLowerCase()}.`)) fail('binding.origins');
    exactKeys(inputs.productFiles, PRODUCT_PATHS, 'binding.productFiles');
    for (const product of PRODUCT_PATHS) {
        const value = inputs.productFiles[product];
        exactKeys(value, ['bytes', 'mime', 'sha256'], `binding.productFiles.${product}`);
        nonNegative(value.bytes, `binding.productFiles.${product}.bytes`); string(value.mime, `binding.productFiles.${product}.mime`); sha(value.sha256, `binding.productFiles.${product}.sha256`);
    }
    return inputs;
}

function readJson(file, invariant) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { fail(invariant, error.message); }
}

const OPERATION_CONFIG_KEYS = ['schemaVersion', 'releaseId', 'releaseRoot', 'acceptedDir', 'failureRoot', 'operationReceiptPath', 'auditReceiptPath', 'negativeReceiptPath', 'closureRoot', 'closureReceiptPath', 'actualChromeEvidencePath', 'releaseReceiptPath', 'workerStdoutPath', 'workerStderrPath', 'campaignDir', 'campaignSpecPath', 'campaignReceiptPath', 'campaignRunId', 'sourceSnapshotDir', 'executionSourceDir', 'authorityProjectRoot', 'authorityWorkspaceRoot', 'deploymentRecordPath', 'immutableUrl', 'aliasUrl', 'nodeExePath', 'nodeExeSha256', 'wranglerJsPath', 'wranglerJsSha256', 'projectName'];
const DERIVED_CONFIG_KEYS = ['schemaVersion', 'baseConfigPath', 'baseConfigSha256', 'mutationId', 'mutationRootRealpath', 'auditTargetRealpath', 'externalOperationReceiptPath', 'auditReceiptPath'];

export function validateOperationConfig(config) {
    exactKeys(config, OPERATION_CONFIG_KEYS, 'config');
    if (config.schemaVersion !== 2 || !RELEASE_ID.test(string(config.releaseId, 'config.releaseId'))) fail('config.schemaVersion');
    for (const key of OPERATION_CONFIG_KEYS.filter((key) => /(?:Path|Dir|Root)$/.test(key))) canonicalPath(config[key], `config.${key}`);
    sha(config.nodeExeSha256, 'config.nodeExeSha256'); sha(config.wranglerJsSha256, 'config.wranglerJsSha256');
    validateUrl(config.immutableUrl, 'config.immutableUrl'); validateUrl(config.aliasUrl, 'config.aliasUrl'); string(config.projectName, 'config.projectName');
    return config;
}

export function validateDerivedAuditConfig(config) {
    exactKeys(config, DERIVED_CONFIG_KEYS, 'auditConfig');
    if (config.schemaVersion !== 3) fail('auditConfig.schemaVersion');
    canonicalPath(config.baseConfigPath, 'auditConfig.baseConfigPath'); sha(config.baseConfigSha256, 'auditConfig.baseConfigSha256'); string(config.mutationId, 'auditConfig.mutationId');
    canonicalPath(config.mutationRootRealpath, 'auditConfig.mutationRootRealpath'); canonicalPath(config.auditTargetRealpath, 'auditConfig.auditTargetRealpath'); canonicalPath(config.externalOperationReceiptPath, 'auditConfig.externalOperationReceiptPath'); canonicalPath(config.auditReceiptPath, 'auditConfig.auditReceiptPath');
    return config;
}

export function validateCampaignClaims(value) {
    const keys = ['schemaVersion', 'runId', 'v1Sha256', 'candidateInventory', 'gameCoreSha256', 'sourceGit', 'unit', 'browser', 'performance', 'negativeControls', 'campaignVerifier', 'r9Frozen', 'r10Frozen', 'actualBrowserZoom'];
    exactKeys(value, keys, 'campaignClaims');
    if (value.schemaVersion !== 5) fail('campaignClaims.schemaVersion'); string(value.runId, 'campaignClaims.runId'); sha(value.v1Sha256, 'campaignClaims.v1Sha256'); sha(value.gameCoreSha256, 'campaignClaims.gameCoreSha256');
    exactKeys(value.candidateInventory, ['fileCount', 'pathListSha256', 'contentRecordsSha256'], 'campaignClaims.candidateInventory'); nonNegative(value.candidateInventory.fileCount, 'campaignClaims.candidateInventory.fileCount'); sha(value.candidateInventory.pathListSha256, 'campaignClaims.candidateInventory.pathListSha256'); sha(value.candidateInventory.contentRecordsSha256, 'campaignClaims.candidateInventory.contentRecordsSha256');
    exactKeys(value.sourceGit, ['branch', 'headSha'], 'campaignClaims.sourceGit'); string(value.sourceGit.branch, 'campaignClaims.sourceGit.branch'); sha(value.sourceGit.headSha, 'campaignClaims.sourceGit.headSha');
    for (const key of ['unit', 'campaignVerifier']) { exactKeys(value[key], ['tests', 'passed', 'failed', 'exitCode'], `campaignClaims.${key}`); if (value[key].tests !== value[key].passed || value[key].failed !== 0 || value[key].exitCode !== 0) fail(`campaignClaims.${key}`); }
    exactKeys(value.browser, ['chromium', 'firefox', 'webkit', 'integrity', 'reportedFailures', 'exitCode'], 'campaignClaims.browser');
    for (const engine of ENGINES) { exactKeys(value.browser[engine], ['passed', 'failed'], `campaignClaims.browser.${engine}`); if (value.browser[engine].passed !== 16 || value.browser[engine].failed !== 0) fail(`campaignClaims.browser.${engine}`); }
    if (value.browser.integrity !== true || value.browser.reportedFailures !== 0 || value.browser.exitCode !== 0) fail('campaignClaims.browser');
    return value;
}

export function validateCampaignEnvelope(value) {
    exactKeys(value, ['schemaVersion', 'runId', 'payloadHashes', 'source', 'spec', 'rawEvidence'], 'campaignEnvelope');
    if (value.schemaVersion !== 5) fail('campaignEnvelope.schemaVersion'); string(value.runId, 'campaignEnvelope.runId');
    object(value.payloadHashes, 'campaignEnvelope.payloadHashes');
    exactKeys(value.source, ['path', 'fileCount', 'pathListSha256', 'contentRecordsSha256', 'gitBranch', 'gitHeadSha'], 'campaignEnvelope.source');
    exactKeys(value.spec, ['fileName', 'sizeBytes', 'sha256'], 'campaignEnvelope.spec');
    exactKeys(value.rawEvidence, ['summary', 'samples'], 'campaignEnvelope.rawEvidence');
    for (const key of ['summary', 'samples']) exactKeys(value.rawEvidence[key], ['path', 'sha256'], `campaignEnvelope.rawEvidence.${key}`);
    return value;
}

export function validateCampaignReceipt(value) {
    const keys = ['schemaVersion', 'runId', 'status', 'createdUtc', 'completedUtc', 'projectRoot', 'cleanRoot', 'campaign', 'spec', 'candidateInventory', 'gameCoreSha256', 'sourceGit', 'r9Frozen', 'r10Frozen', 'commands', 'limitation', 'publicationState'];
    exactKeys(value, keys, 'campaignReceipt');
    if (value.schemaVersion !== 1 || value.status !== 'VERIFIED') fail('campaignReceipt.status');
    exactKeys(value.campaign, ['path', 'artifactManifestSha256', 'submissionEnvelopeSha256'], 'campaignReceipt.campaign');
    exactKeys(value.spec, ['path', 'sizeBytes', 'sha256'], 'campaignReceipt.spec'); exactKeys(value.candidateInventory, ['fileCount', 'pathListSha256', 'contentRecordsSha256'], 'campaignReceipt.candidateInventory'); exactKeys(value.sourceGit, ['branch', 'headSha'], 'campaignReceipt.sourceGit');
    if (!Array.isArray(value.commands)) fail('campaignReceipt.commands');
    return value;
}

export function validatePngEvidence(file, viewport, invariant = 'png') {
    exactKeys(viewport, ['width', 'height'], `${invariant}.viewport`);
    const dimensions = pngDimensions(file, invariant);
    if (dimensions.width !== viewport.width || dimensions.height !== viewport.height) fail(`${invariant}.viewport`);
    return dimensions;
}

function resolveConfig(configPath) {
    const canonicalConfig = canonicalPath(configPath, 'config.path');
    noSymlinkAncestors(canonicalConfig, 'config.path');
    const config = readJson(canonicalConfig, 'config.json');
    if (config.schemaVersion === 2) {
        validateOperationConfig(config);
        return { base: config, config, configPath: canonicalConfig, target: config.acceptedDir, auditReceiptPath: config.auditReceiptPath, operationReceiptPath: config.operationReceiptPath };
    }
    if (config.schemaVersion !== 3) fail('config.schemaVersion');
    validateDerivedAuditConfig(config);
    const baseConfigPath = canonicalPath(config.baseConfigPath, 'auditConfig.baseConfigPath');
    if (sha256File(baseConfigPath) !== sha(config.baseConfigSha256, 'auditConfig.baseConfigSha256')) fail('auditConfig.baseConfigSha256');
    const baseResolved = resolveConfig(baseConfigPath);
    const root = fs.realpathSync(config.mutationRootRealpath);
    const target = fs.realpathSync(config.auditTargetRealpath);
    if (target !== path.join(root, 'accepted') || target === fs.realpathSync(baseResolved.target)) fail('auditConfig.auditTargetRealpath');
    if (canonicalPath(config.externalOperationReceiptPath, 'auditConfig.externalOperationReceiptPath') !== canonicalPath(baseResolved.operationReceiptPath, 'auditConfig.externalOperationReceiptPath')) fail('auditConfig.externalOperationReceiptPath');
    return { base: baseResolved.base, config, configPath: canonicalConfig, target, auditReceiptPath: canonicalPath(config.auditReceiptPath, 'auditConfig.auditReceiptPath'), operationReceiptPath: baseResolved.operationReceiptPath };
}

export function validateOperationReceipt(receipt) {
    const keys = ['schemaVersion', 'releaseId', 'createdUtc', 'status', 'configPath', 'configSha256', 'orchestratorPath', 'orchestratorSha256', 'campaignVerifier', 'worker', 'accepted', 'screenshotBindings', 'cloudflareReads', 'fileProbes'];
    exactKeys(receipt, keys, 'operationReceipt');
    if (receipt.schemaVersion !== 1 || receipt.status !== 'VERIFIED') fail('operationReceipt.status');
    string(receipt.releaseId, 'operationReceipt.releaseId'); utc(receipt.createdUtc, 'operationReceipt.createdUtc'); sha(receipt.configSha256, 'operationReceipt.configSha256');
    exactKeys(receipt.accepted, ['realpath', 'manifestPath', 'manifestSha256', 'treeDigest', 'publishedUtc', 'eventsPath', 'eventsSha256', 'eventCount', 'finalEventSha256'], 'operationReceipt.accepted');
    if (receipt.accepted.eventCount !== 278) fail('operationReceipt.accepted.eventCount');
    for (const key of ['manifestSha256', 'treeDigest', 'eventsSha256', 'finalEventSha256']) sha(receipt.accepted[key], `operationReceipt.accepted.${key}`);
    if (!Array.isArray(receipt.screenshotBindings) || receipt.screenshotBindings.length !== 18) fail('operationReceipt.screenshotBindings');
    receipt.screenshotBindings.forEach((binding) => {
        exactKeys(binding, ['case', 'stage', 'path', 'pngSha256', 'oracleSha256', 'captureStartUtc', 'captureEndUtc'], 'operationReceipt.screenshotBinding');
        if (!expectedCaseLabels().includes(binding.case) || !STAGES.includes(binding.stage)) fail('operationReceipt.screenshotBinding.tuple');
        relativeFile(binding.path, 'operationReceipt.screenshotBinding.path'); sha(binding.pngSha256, 'operationReceipt.screenshotBinding.pngSha256'); sha(binding.oracleSha256, 'operationReceipt.screenshotBinding.oracleSha256'); utc(binding.captureStartUtc, 'operationReceipt.screenshotBinding.captureStartUtc'); utc(binding.captureEndUtc, 'operationReceipt.screenshotBinding.captureEndUtc');
    });
    exactKeys(receipt.cloudflareReads, ['pre', 'mid', 'post'], 'operationReceipt.cloudflareReads');
    for (const phase of ['pre', 'mid', 'post']) {
        const read = receipt.cloudflareReads[phase];
        exactKeys(read, ['capturePath', 'captureSha256', 'deploymentId'], `operationReceipt.cloudflareReads.${phase}`);
        string(read.capturePath, `operationReceipt.cloudflareReads.${phase}.capturePath`); sha(read.captureSha256, `operationReceipt.cloudflareReads.${phase}.captureSha256`); string(read.deploymentId, `operationReceipt.cloudflareReads.${phase}.deploymentId`);
    }
    exactKeys(receipt.fileProbes, ['initialPath', 'initialSha256', 'initialPassed', 'initialTotal', 'finalAliasPath', 'finalAliasSha256', 'finalAliasPassed', 'finalAliasTotal'], 'operationReceipt.fileProbes');
    if (receipt.fileProbes.initialPassed !== 10 || receipt.fileProbes.initialTotal !== 10 || receipt.fileProbes.finalAliasPassed !== 5 || receipt.fileProbes.finalAliasTotal !== 5) fail('operationReceipt.fileProbes');
    for (const key of ['initialSha256', 'finalAliasSha256']) sha(receipt.fileProbes[key], `operationReceipt.fileProbes.${key}`);
    return receipt;
}

function validateDeploymentRecord(record) {
    exactKeys(record, ['schemaVersion', 'projectName', 'deploymentId', 'environment', 'branch', 'sourceGitHead', 'immutableUrl', 'aliasUrl', 'productFiles', 'capturedUtc'], 'deploymentRecord');
    if (record.schemaVersion !== 1 || record.environment !== 'Production' || record.branch !== 'main') fail('deploymentRecord.identity');
    string(record.projectName, 'deploymentRecord.projectName'); string(record.deploymentId, 'deploymentRecord.deploymentId'); sha(record.sourceGitHead, 'deploymentRecord.sourceGitHead'); utc(record.capturedUtc, 'deploymentRecord.capturedUtc');
    validateBinding({ releaseId: '20260813T010203Z-r14-public-smoke-v2', deploymentId: record.deploymentId, projectName: record.projectName, immutableUrl: record.immutableUrl, aliasUrl: record.aliasUrl, productFiles: record.productFiles });
    return record;
}

function validateEvents(events, receipt) {
    if (events.length !== 278) fail('events.cardinality');
    let previous = ZERO_SHA256;
    const perCase = new Map(expectedCaseLabels().map((label) => [label, { start: 0, finish: 0, inputs: 0, oracle: 0, screenshots: 0 }]));
    events.forEach((event, index) => {
        exactKeys(event, ['seq', 'previousEventSha256', 'eventSha256', 'utc', 'monotonicMs', 'type', 'case', 'payload'], 'event');
        if (event.seq !== index + 1 || event.previousEventSha256 !== previous) fail('events.chain');
        const calculated = sha256Bytes(canonicalJson({ seq: event.seq, previousEventSha256: event.previousEventSha256, utc: event.utc, monotonicMs: event.monotonicMs, type: event.type, case: event.case, payload: event.payload }));
        if (event.eventSha256 !== calculated) fail('events.hash');
        if (index === 0) {
            if (event.type !== 'operation-start' || event.case !== null) fail('events.operationStart');
            exactKeys(event.payload, ['releaseId', 'matrix'], 'events.operationStart.payload');
            sameArray(event.payload.matrix, expectedCaseLabels(), 'events.operationStart.matrix');
        } else if (index === events.length - 1) {
            if (event.type !== 'operation-finish' || event.case !== null) fail('events.operationFinish');
            exactKeys(event.payload, ['caseCount', 'screenshotCount'], 'events.operationFinish.payload');
            if (event.payload.caseCount !== 6 || event.payload.screenshotCount !== 18) fail('events.operationFinish.payload');
        } else {
            const count = perCase.get(event.case);
            if (!count) fail('events.case');
            if (event.type === 'case-start') { exactKeys(event.payload, ['engine', 'originKind', 'requestedUrl'], 'events.caseStart.payload'); count.start++; }
            else if (event.type === 'trusted-input') { exactKeys(event.payload, ['actionSeq', 'api', 'target', 'preStateSha256', 'postStateSha256', 'resultingUrl'], 'events.trustedInput.payload'); count.inputs++; }
            else if (event.type === 'screenshot-oracle') { exactKeys(event.payload, ['stage', 'oracleSha256'], 'events.screenshotOracle.payload'); count.oracle++; }
            else if (event.type === 'screenshot-written') { exactKeys(event.payload, ['stage', 'path', 'pngSha256', 'oracleSha256'], 'events.screenshotWritten.payload'); count.screenshots++; }
            else if (event.type === 'case-finish') { exactKeys(event.payload, ['actionCount', 'finalUrl'], 'events.caseFinish.payload'); if (event.payload.actionCount !== 38) fail('events.caseFinish.payload'); count.finish++; }
            else fail('events.type');
        }
        previous = event.eventSha256;
    });
    for (const count of perCase.values()) if (count.start !== 1 || count.finish !== 1 || count.inputs !== 38 || count.oracle !== 3 || count.screenshots !== 3) fail('events.schedule');
    if (previous !== receipt.accepted.finalEventSha256) fail('events.finalEventSha256');
}

export function validateAuditReceipt(receipt) {
    const keys = ['schemaVersion', 'releaseId', 'status', 'createdUtc', 'auditedTargetRealpath', 'configSha256', 'operationReceiptSha256', 'acceptedManifestSha256', 'eventsSha256', 'finalEventSha256', 'deploymentId', 'passedCases', 'totalCases', 'controlPlaneReads', 'initialFileGate', 'finalAliasGate', 'screenshotBindings'];
    exactKeys(receipt, keys, 'auditReceipt');
    if (receipt.schemaVersion !== 1 || receipt.status !== 'VERIFIED' || receipt.passedCases !== 6 || receipt.totalCases !== 6 || receipt.controlPlaneReads !== 3) fail('auditReceipt.summary');
    exactKeys(receipt.initialFileGate, ['passed', 'total'], 'auditReceipt.initialFileGate'); exactKeys(receipt.finalAliasGate, ['passed', 'total'], 'auditReceipt.finalAliasGate');
    if (receipt.initialFileGate.passed !== 10 || receipt.initialFileGate.total !== 10 || receipt.finalAliasGate.passed !== 5 || receipt.finalAliasGate.total !== 5) fail('auditReceipt.gates');
    for (const key of ['configSha256', 'operationReceiptSha256', 'acceptedManifestSha256', 'eventsSha256', 'finalEventSha256']) sha(receipt[key], `auditReceipt.${key}`);
    if (!Array.isArray(receipt.screenshotBindings) || receipt.screenshotBindings.length !== 18) fail('auditReceipt.screenshotBindings');
    return receipt;
}

export function auditAcceptedRun(options) {
    const resolved = resolveConfig(options.configPath ?? options);
    const operationReceiptPath = canonicalPath(resolved.operationReceiptPath, 'operationReceipt.path');
    const operationBytesHash = sha256File(operationReceiptPath);
    const operation = validateOperationReceipt(readJson(operationReceiptPath, 'operationReceipt.json'));
    if (operation.releaseId !== resolved.base.releaseId || operation.configSha256 !== sha256File(resolved.configPath) || fs.realpathSync(operation.accepted.realpath) !== fs.realpathSync(resolved.target)) fail('operationReceipt.binding');
    const deployment = validateDeploymentRecord(readJson(resolved.base.deploymentRecordPath, 'deploymentRecord.json'));
    if (deployment.projectName !== resolved.base.projectName || deployment.immutableUrl !== resolved.base.immutableUrl || deployment.aliasUrl !== resolved.base.aliasUrl) fail('deploymentRecord.configBinding');
    for (const phase of ['pre', 'mid', 'post']) if (operation.cloudflareReads[phase].deploymentId !== deployment.deploymentId) fail(`cloudflare.${phase}DeploymentId`);
    const root = fs.realpathSync(resolved.target);
    const manifestPath = path.join(root, 'artifact-manifest.json');
    const eventsPath = path.join(root, 'runner-events.jsonl');
    if (canonicalPath(operation.accepted.manifestPath, 'operationReceipt.manifestPath') !== manifestPath || canonicalPath(operation.accepted.eventsPath, 'operationReceipt.eventsPath') !== eventsPath) fail('operationReceipt.acceptedPaths');
    const manifest = validateManifest(root, readJson(manifestPath, 'manifest.json'));
    validateAcceptedManifest(manifest);
    const manifestHash = sha256File(manifestPath);
    if (manifestHash !== operation.accepted.manifestSha256 || manifest.releaseId !== resolved.base.releaseId) fail('manifest.operationReceiptBinding');
    const eventsHash = sha256File(eventsPath);
    if (eventsHash !== operation.accepted.eventsSha256) fail('events.operationReceiptBinding');
    const events = fs.readFileSync(eventsPath, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    validateEvents(events, operation);
    const accepted = readJson(path.join(root, 'accepted-run.json'), 'acceptedRun.json');
    exactKeys(accepted, ['schemaVersion', 'releaseId', 'campaignRunId', 'sourceGitHead', 'deploymentId', 'immutableUrl', 'aliasUrl', 'startedUtc', 'finishedUtc', 'startedMonotonicMs', 'finishedMonotonicMs', 'engines', 'originKinds', 'attemptsPerCase', 'retries', 'skips', 'caseLabels', 'observationsPath', 'eventsPath', 'screenshotCount', 'productFiles', 'tooling'], 'acceptedRun');
    if (accepted.schemaVersion !== SMOKE_SCHEMA_VERSION || accepted.releaseId !== resolved.base.releaseId || accepted.deploymentId !== deployment.deploymentId || accepted.immutableUrl !== deployment.immutableUrl || accepted.aliasUrl !== deployment.aliasUrl || accepted.attemptsPerCase !== 1 || accepted.retries !== 0 || accepted.skips !== 0 || accepted.screenshotCount !== 18) fail('acceptedRun.summary');
    sameArray(accepted.engines, ENGINES, 'acceptedRun.engines'); sameArray(accepted.originKinds, ORIGINS, 'acceptedRun.originKinds'); sameArray(accepted.caseLabels, expectedCaseLabels(), 'acceptedRun.caseLabels');
    const observationsPath = path.join(root, 'observations.json');
    if (canonicalPath(accepted.observationsPath, 'acceptedRun.observationsPath') !== observationsPath) fail('acceptedRun.observationsPath');
    const cases = readJson(observationsPath, 'observations.json');
    if (!Array.isArray(cases) || cases.length !== 6) fail('observations.cardinality');
    const labels = cases.map((record) => record.label);
    if (canonicalJson(labels) !== canonicalJson(expectedCaseLabels())) fail('observations.matrix');
    cases.forEach(validateCaseFull);
    const screenshotBindings = cases.flatMap((record) => record.screenshots.map((screenshot) => ({ case: screenshot.caseLabel, stage: screenshot.stage, path: screenshot.relativePath, pngSha256: screenshot.sha256, oracleSha256: screenshot.oracleSnapshotSha256, captureStartUtc: screenshot.captureStartedUtc, captureEndUtc: screenshot.captureFinishedUtc })));
    if (canonicalJson(screenshotBindings) !== canonicalJson(operation.screenshotBindings)) fail('screenshot.operationReceiptBinding');
    if (canonicalJson(accepted.productFiles) !== canonicalJson(deployment.productFiles)) fail('acceptedRun.productFiles');
    const receipt = {
        schemaVersion: 1, releaseId: resolved.base.releaseId, status: 'VERIFIED', createdUtc: new Date().toISOString(), auditedTargetRealpath: root,
        configSha256: sha256File(resolved.configPath), operationReceiptSha256: operationBytesHash, acceptedManifestSha256: manifestHash, eventsSha256: eventsHash,
        finalEventSha256: operation.accepted.finalEventSha256, deploymentId: accepted.deploymentId, passedCases: 6, totalCases: 6, controlPlaneReads: 3,
        initialFileGate: { passed: 10, total: 10 }, finalAliasGate: { passed: 5, total: 5 }, screenshotBindings,
    };
    validateAuditReceipt(receipt);
    return receipt;
}

export function auditorModulePath() {
    return fileURLToPath(new URL('./verify-public-smoke-v2.mjs', import.meta.url));
}
