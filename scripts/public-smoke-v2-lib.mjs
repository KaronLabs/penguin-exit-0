import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

export const SMOKE_SCHEMA_VERSION = 2;
export const ENGINES = Object.freeze(['chromium', 'firefox', 'webkit']);
export const ORIGINS = Object.freeze(['immutable', 'alias']);
export const STAGES = Object.freeze(['initial', 'progress', 'ending']);
export const NEGATIVE_CONTROL_REGISTRY = Object.freeze([
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
].map(([id, expectedInvariant]) => Object.freeze({ id, expectedInvariant })));

const PRODUCT_PATHS = Object.freeze(['/', '/content.js', '/game-core.js', '/script.js', '/style.css']);
const RELEASE_ID = /^[0-9]{8}T[0-9]{6}Z-r14-public-smoke-v2$/;
const CAMPAIGN_ID = /^[0-9]{8}T[0-9]{6}Z-r10-korean-release$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXTERNAL_SHA256 = /^[A-Fa-f0-9]{64}$/;
const GIT_SHA1 = /^[a-f0-9]{40}$/;
const ACCOUNT_ID = /^[a-f0-9]{32}$/;
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

function externalSha(value, invariant) {
    if (!EXTERNAL_SHA256.test(string(value, invariant))) fail(invariant, 'must be 64 hex');
    return value;
}

function sameHash(left, right) {
    return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
}

function utc(value, invariant) {
    const candidate = string(value, invariant);
    if (!candidate.endsWith('Z') || !Number.isFinite(Date.parse(candidate))) fail(invariant, 'must be UTC date');
    return value;
}

function number(value, invariant) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(invariant, 'must be finite number');
    return value;
}

function gitSha(value, invariant) {
    if (!GIT_SHA1.test(string(value, invariant))) fail(invariant, 'must be 40 lowercase hex');
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
    const candidate = string(file, invariant);
    if (!path.isAbsolute(candidate)) fail(invariant, 'must be absolute');
    return path.resolve(candidate);
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

export function enforceStrictDeadline(elapsedMs, limitMs, invariant) {
    number(elapsedMs, invariant);
    number(limitMs, `${invariant}.limit`);
    if (elapsedMs < 0 || limitMs <= 0 || elapsedMs >= limitMs) fail(invariant, `elapsedMs=${elapsedMs} limitMs=${limitMs}`);
    return elapsedMs;
}

export function createRunnerEventLedger() {
    const events = [];
    return Object.freeze({
        append(input) {
            exactKeys(input, ['utc', 'monotonicMs', 'type', 'case', 'payload'], 'runner.event.input');
            utc(input.utc, 'runner.event.utc');
            number(input.monotonicMs, 'runner.event.monotonicMs');
            string(input.type, 'runner.event.type');
            if (input.case !== null) string(input.case, 'runner.event.case');
            object(input.payload, 'runner.event.payload');
            const event = {
                seq: events.length + 1,
                previousEventSha256: events.at(-1)?.eventSha256 ?? ZERO_SHA256,
                utc: input.utc,
                monotonicMs: input.monotonicMs,
                type: input.type,
                case: input.case,
                payload: input.payload,
            };
            event.eventSha256 = sha256Bytes(canonicalJson(event));
            events.push(Object.freeze(event));
            return events.at(-1);
        },
        finalizeTrustedInput(caseLabel, actionSeq, postStateSha256, resultingUrl) {
            const index = events.findIndex((event) => event.type === 'trusted-input' && event.case === caseLabel && event.payload.actionSeq === actionSeq);
            if (index < 0) fail('runner.event.finalizeTrustedInput');
            const target = events[index];
            events[index] = { ...target, payload: { ...target.payload, postStateSha256, resultingUrl } };
            for (let cursor = index; cursor < events.length; cursor += 1) {
                const { eventSha256: _discarded, ...payload } = events[cursor];
                payload.previousEventSha256 = cursor === 0 ? ZERO_SHA256 : events[cursor - 1].eventSha256;
                events[cursor] = Object.freeze({ ...payload, eventSha256: sha256Bytes(canonicalJson(payload)) });
            }
            return events[index];
        },
        records() {
            return [...events];
        },
    });
}

export const PINNED_AST_GREP_PATH = 'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WinGet\\Packages\\ast-grep.ast-grep_Microsoft.Winget.Source_8wekyb3d8bbwe\\ast-grep.exe';
const PINNED_AST_GREP_SHA256 = '584c59eaf3b50bf436ad43cf36193af1d2fe5e29ddb21b7485c39f131691390f';
const PINNED_AST_GREP_VERSION = 'ast-grep 0.44.0';

export function resolvePlaywrightAuthority(sourceSnapshotDir, { resolvePackage = (specifier) => createRequire(import.meta.url).resolve(specifier) } = {}) {
    try {
        const rawResolvedPath = resolvePackage('playwright/package.json');
        const resolvedPath = path.resolve(rawResolvedPath);
        if (!path.isAbsolute(rawResolvedPath) || rawResolvedPath !== resolvedPath) fail('playwrightAuthority.path');
        const stat = fs.lstatSync(resolvedPath);
        if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(resolvedPath) !== resolvedPath) fail('playwrightAuthority.path');
        const installed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
        const declared = JSON.parse(fs.readFileSync(path.join(sourceSnapshotDir, 'package.json'), 'utf8')).devDependencies?.['@playwright/test'];
        const declaredVersion = typeof declared === 'string' ? declared.replace(/^[~^]/, '') : '';
        if (installed.name !== 'playwright' || installed.version !== declaredVersion) fail('playwrightAuthority.version');
        return { path: 'node_modules/playwright/package.json', version: installed.version, sha256: sha256File(resolvedPath), resolvedPath };
    } catch (error) {
        if (error.message?.startsWith('playwrightAuthority.')) throw error;
        fail('playwrightAuthority.path', error.code ?? error.message);
    }
}

export function validatePlaywrightToolingDeclaration(authority, declaration) {
    exactKeys(declaration, ['path', 'version', 'sha256'], 'playwrightAuthority.declaration');
    if (declaration.path !== authority.path || declaration.version !== authority.version || declaration.sha256 !== authority.sha256) fail('playwrightAuthority.declaration');
    return declaration;
}

export function validatePinnedParserAuthority({ parserPath = PINNED_AST_GREP_PATH, expectedSha256 = PINNED_AST_GREP_SHA256, expectedVersion = PINNED_AST_GREP_VERSION } = {}) {
    try {
        const resolved = path.resolve(parserPath);
        const stat = fs.lstatSync(resolved);
        if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved || sha256File(resolved) !== expectedSha256) fail('runner.parserAuthority');
        const result = spawnSync(resolved, ['--version'], { encoding: 'utf8', windowsHide: true, shell: false });
        if (result.status !== 0 || result.signal !== null || result.stderr !== '' || result.stdout !== `${expectedVersion}\n`) fail('runner.parserAuthority');
        return resolved;
    } catch (error) {
        if (error.message?.startsWith('runner.parserAuthority')) throw error;
        fail('runner.parserAuthority', error.code ?? error.message);
    }
}

function astMatches(parserPath, source, selector, value) {
    const option = selector === 'pattern' ? '-p' : '--kind';
    const result = spawnSync(parserPath, ['run', option, value, '-l', 'js', '--json=stream', '--stdin'], { input: source, encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 8 * 1024 * 1024 });
    if (![0, 1].includes(result.status) || result.signal !== null || result.stderr !== '') fail('runner.policy.ast', result.stderr || `status=${result.status}`);
    return result.stdout.trim() ? result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)) : [];
}

function validateReadOnlyCallback(parserPath, callback) {
    const declared = new Set();
    const localFunctions = new Set();
    for (const keyword of ['const', 'let', 'var']) for (const node of astMatches(parserPath, callback, 'pattern', `${keyword} $NAME = $VALUE`)) {
        const name = node.metaVariables?.single?.NAME?.text;
        if (name) declared.add(name);
    }
    for (const pattern of ['const $NAME = ($$$PARAMS) => $BODY', 'const $NAME = $PARAM => $BODY']) for (const node of astMatches(parserPath, callback, 'pattern', pattern)) {
        const name = node.metaVariables?.single?.NAME?.text;
        if (name) localFunctions.add(name);
    }
    for (const node of astMatches(parserPath, callback, 'kind', 'assignment_expression')) {
        const left = node.text.split(/\s*(?:=|\+=|-=|\*=|\/=|&&=|\|\|=|\?\?=)\s*/, 1)[0];
        if (!/^[A-Za-z_$][\w$]*$/.test(left) || !declared.has(left)) fail('runner.policy.callback.write', node.text);
    }
    for (const node of astMatches(parserPath, callback, 'kind', 'update_expression')) {
        const identifier = node.text.replace(/\+\+|--/g, '').trim();
        if (!declared.has(identifier)) fail('runner.policy.callback.write', node.text);
    }
    if (astMatches(parserPath, callback, 'kind', 'new_expression').some(({ text }) => !text.startsWith('new Error('))) fail('runner.policy.callback.construct');
    if (astMatches(parserPath, callback, 'kind', 'unary_expression').some(({ text }) => text.trim().startsWith('delete '))) fail('runner.policy.callback.delete');
    if (astMatches(parserPath, callback, 'kind', 'member_expression').some(({ text }) => /^(?:application|window|globalThis)\./.test(text))) fail('runner.policy.callback.capability');
    const directReadCall = /^(?:document\.(?:querySelector|querySelectorAll|elementFromPoint)|localStorage\.getItem|getComputedStyle|Boolean|Number|Math\.(?:min|max))\s*\(/;
    const readMethodCall = /\??\.(?:getAttribute|getClientRects|contains|match|trim|slice|reverse|find|findIndex|map|flatMap)\s*\(/;
    for (const node of astMatches(parserPath, callback, 'kind', 'call_expression')) {
        const bareCallee = /^([A-Za-z_$][\w$]*)\s*\(/.exec(node.text)?.[1];
        if (!directReadCall.test(node.text) && !readMethodCall.test(node.text) && !localFunctions.has(bareCallee)) fail('runner.policy.callback.call', node.text);
    }
    for (const node of astMatches(parserPath, callback, 'kind', 'await_expression')) if (node.text.trim() !== 'await document.fonts.ready') fail('runner.policy.callback.await');
}

export function validateRunnerSourcePolicy(source) {
    string(source, 'runner.policy.source');
    const parserPath = validatePinnedParserAuthority();
    const capabilityTypes = new Map([['page', 'page'], ['context', 'context'], ['browser', 'browser'], ['browserType', 'browserType'], ['locator', 'locator']]);
    const capabilityFactories = new Map();
    const taintedCallables = new Set();
    const declarations = ['const', 'let', 'var'].flatMap((keyword) => astMatches(parserPath, source, 'pattern', `${keyword} $ALIAS = $VALUE`));
    for (let changed = true; changed;) {
        changed = false;
        for (const declaration of declarations) {
            const alias = declaration.metaVariables?.single?.ALIAS?.text;
            const value = declaration.metaVariables?.single?.VALUE?.text ?? '';
            const directType = capabilityTypes.get(value);
            const locatorType = [...capabilityTypes].some(([name, type]) => type === 'page' && value.startsWith(`${name}.locator(`)) ? 'locator' : null;
            const factoryType = /^([A-Za-z_$][\w$]*)\(\)$/.exec(value)?.[1];
            const resolvedType = directType ?? locatorType ?? capabilityFactories.get(factoryType);
            if (alias && resolvedType && !capabilityTypes.has(alias)) { capabilityTypes.set(alias, resolvedType); changed = true; }
            const returned = /^(?:async\s*)?\([^)]*\)\s*=>\s*([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
            if (alias && returned && capabilityTypes.has(returned) && !capabilityFactories.has(alias)) { capabilityFactories.set(alias, capabilityTypes.get(returned)); changed = true; }
        }
    }
    const destructuring = ['const', 'let', 'var'].flatMap((keyword) => astMatches(parserPath, source, 'pattern', `${keyword} { $$$PROPERTIES } = $VALUE`));
    for (const declaration of destructuring) {
        const value = declaration.metaVariables?.single?.VALUE?.text ?? '';
        const directType = capabilityTypes.get(value);
        const locatorType = [...capabilityTypes].some(([name, type]) => type === 'page' && value.startsWith(`${name}.locator(`)) ? 'locator' : null;
        const factoryName = /^([A-Za-z_$][\w$]*)\(\)$/.exec(value)?.[1];
        if (!(directType ?? locatorType ?? capabilityFactories.get(factoryName))) continue;
        for (const property of declaration.metaVariables?.multi?.PROPERTIES ?? []) {
            if (property.text === ',') continue;
            const rest = /^\.\.\.([A-Za-z_$][\w$]*)$/.exec(property.text)?.[1];
            if (rest) { capabilityTypes.set(rest, directType ?? locatorType ?? capabilityFactories.get(factoryName)); continue; }
            const callable = /^(?:[A-Za-z_$][\w$]*\s*:\s*)?([A-Za-z_$][\w$]*)$/.exec(property.text)?.[1];
            if (callable) taintedCallables.add(callable);
            else fail('runner.policy.capabilityDestructure', property.text);
        }
    }
    for (const { text } of astMatches(parserPath, source, 'kind', 'subscript_expression')) {
        const receiver = /^([A-Za-z_$][\w$]*)\s*(?:\?\.)?\[/.exec(text)?.[1];
        if ((receiver && capabilityTypes.has(receiver)) || [...capabilityTypes].some(([name, type]) => type === 'page' && text.startsWith(`${name}.locator(`))) fail('runner.policy.computedCapability', text);
    }
    const calls = astMatches(parserPath, source, 'kind', 'call_expression');
    const computedMembers = astMatches(parserPath, source, 'kind', 'subscript_expression');
    for (const member of computedMembers) if (calls.some((call) => call.range.byteOffset.start === member.range.byteOffset.start && call.text.startsWith(`${member.text}(`))) fail('runner.policy.computedCall', member.text);
    const browserMembers = { page: new Set(['evaluate', 'getByRole', 'goto', 'keyboard', 'locator', 'on', 'reload', 'screenshot', 'setViewportSize', 'url']), context: new Set(['close', 'newPage']), browser: new Set(['close', 'newContext', 'version']), browserType: new Set(['launch']), locator: new Set(['click']) };
    for (const { text } of astMatches(parserPath, source, 'kind', 'member_expression')) {
        const match = /^([A-Za-z_$][\w$]*)\?\.([A-Za-z_$][\w$]*)|^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/.exec(text);
        const receiver = match?.[1] ?? match?.[3], member = match?.[2] ?? match?.[4], type = capabilityTypes.get(receiver);
        if (type && !browserMembers[type].has(member)) fail('runner.policy.browserCapability', text);
    }
    for (const { text } of calls) {
        const bareCallee = /^([A-Za-z_$][\w$]*)\s*\(/.exec(text)?.[1];
        if (bareCallee && taintedCallables.has(bareCallee)) fail('runner.policy.capabilityCall', text);
        const locatorCall = /^([A-Za-z_$][\w$]*)\??\.click\s*\(/.exec(text)?.[1];
        if (locatorCall && capabilityTypes.get(locatorCall) === 'locator' && text !== `${locatorCall}.click()`) fail('runner.policy.directClick', text);
        if (/^(?:page\.(?:locator|getByRole)\([\s\S]*\)|locator)\.click\s*\(/.test(text) && text !== 'locator.click()' && !/^page\.getByRole\([\s\S]*\)\.click\(\)$/.test(text)) fail('runner.policy.directClick', text);
        const event = /^page\.on\((['"])([^'"]+)\1/.exec(text)?.[2];
        if (event && !['console', 'pageerror', 'requestfailed', 'response', 'request'].includes(event)) fail('runner.policy.pageEvent', event);
    }
    const suspiciousEvaluate = calls.filter((node) => /evaluate|eva['"]?\s*\+\s*['"]?luate/.test(node.text));
    const evaluations = astMatches(parserPath, source, 'pattern', '$PAGE.evaluate($$$ARGS)');
    const allowedNames = ['readDocumentSnapshot', 'readVisibilityPrimitives', 'readStatePrimitives', 'readScreenshotOracle'];
    if (suspiciousEvaluate.length !== evaluations.length || evaluations.some((node) => node.metaVariables?.single?.PAGE?.text !== 'page')) fail('runner.policy.evaluate');
    if (evaluations.length === 0) {
        const allowedOuterCall = /^(?:readDocumentSnapshot|readVisibilityPrimitives|readStatePrimitives|readScreenshotOracle|page\.getByRole|page\.keyboard\.press)\s*\(|^page\.getByRole\([\s\S]*\)\.click\s*\(/;
        if (calls.some((node) => !allowedOuterCall.test(node.text))) fail('runner.policy.outerCall');
        if (astMatches(parserPath, source, 'kind', 'assignment_expression').length || astMatches(parserPath, source, 'kind', 'update_expression').length || astMatches(parserPath, source, 'kind', 'new_expression').length) fail('runner.policy.outerWrite');
        return true;
    }
    const claimed = new Set();
    for (const name of allowedNames) {
        const functions = astMatches(parserPath, source, 'pattern', `async function ${name}($$$PARAMS) { $$$BODY }`);
        if (functions.length === 0) continue;
        if (functions.length !== 1) fail('runner.policy.evaluate', name);
        const start = functions[0].range.byteOffset.start, end = functions[0].range.byteOffset.end;
        const contained = evaluations.filter((node) => node.range.byteOffset.start >= start && node.range.byteOffset.end <= end);
        if (contained.length === 0) continue;
        if (contained.length !== 1) fail('runner.policy.evaluate', name);
        claimed.add(contained[0].range.byteOffset.start);
        const args = contained[0].metaVariables.multi.ARGS.filter(({ text }) => text !== ',');
        if (![1, 2].includes(args.length)) fail('runner.policy.evaluate', name);
        validateReadOnlyCallback(parserPath, args[0].text);
    }
    if (claimed.size !== evaluations.length) fail('runner.policy.evaluate');
    return true;
}

export function sha256File(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('file.regular', file);
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function validateExecutedSnapshotBinding(executedPath, snapshotPath) {
    canonicalPath(executedPath, 'scriptBinding.executed'); canonicalPath(snapshotPath, 'scriptBinding.snapshot');
    if (sha256File(executedPath) !== sha256File(snapshotPath)) fail('scriptBinding');
    return true;
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
    const allowedKeys = [...primitiveKeys].sort();
    if (actualKeys.length !== allowedKeys.length || actualKeys.some((key, index) => key !== allowedKeys[index])) fail('visibility', `keys=${actualKeys.join(',')}`);
    bool(raw.hiddenAttribute, 'visibility.hiddenAttribute'); string(raw.display, 'visibility.display'); string(raw.position, 'visibility.position'); string(raw.visibility, 'visibility.visibility'); number(raw.opacity, 'visibility.opacity');
    if (!Array.isArray(raw.clientRects)) fail('visibility.clientRects');
    raw.clientRects.forEach((rect) => { exactKeys(rect, ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'], 'visibility.clientRect'); for (const key of ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left']) number(rect[key], `visibility.clientRect.${key}`); });
    for (const key of ['intersectionArea', 'intersectionRatio', 'viewportWidth', 'viewportHeight', 'centerX', 'centerY']) number(raw[key], `visibility.${key}`);
    if (raw.viewportWidth <= 0 || raw.viewportHeight <= 0) fail('visibility.viewport');
    string(raw.hitElementId, 'visibility.hitElementId'); bool(raw.hitIsSelfOrDescendant, 'visibility.hitIsSelfOrDescendant');
    return raw.hiddenAttribute === false
        && raw.display !== 'none'
        && !['hidden', 'collapse'].includes(raw.visibility)
        && raw.opacity > 0
        && raw.clientRects.some((rect) => rect.width > 0 && rect.height > 0)
        && raw.intersectionArea > 0
        && raw.intersectionRatio > 0
        && raw.intersectionRatio <= 1
        && raw.centerX >= 0
        && raw.centerX < raw.viewportWidth
        && raw.centerY >= 0
        && raw.centerY < raw.viewportHeight
        && raw.hitIsSelfOrDescendant;
}

function pngDimensions(file, invariant) {
    const data = fs.readFileSync(file);
    if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) fail(`${invariant}.signature`);
    if (data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') fail(`${invariant}.structure`);
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (!width || !height) fail(`${invariant}.structure`, 'zero PNG dimensions');
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
        if (files.some((file) => file.toLowerCase() === relative.toLowerCase())) fail('manifest.caseCollision', relative);
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

export function validateSignature(value) {
    const keys = ['command', 'commandKind', 'system', 'systemKind', 'roast', 'roastKind', 'pseudoLabel', 'tabs'];
    exactKeys(value, keys, 'signature');
    const expected = {
        command: 'archon@stone-igloo:~$ systemctl restart nginx', commandKind: 'command',
        system: 'Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.', systemKind: 'system',
        roast: '아콘 🐧 // 내 할머니도 너보단 코딩을 잘하겠다.', roastKind: 'archon', pseudoLabel: '"ARCHON // ROAST"',
    };
    for (const [key, expectedValue] of Object.entries(expected)) if (value[key] !== expectedValue) fail(`signature.${key}`);
    exactKeys(value.tabs, ['wifiAriaSelected', 'wifiTabIndex', 'cpuAriaSelected', 'cpuTabIndex', 'panelAriaLabelledby', 'terminalRowsPersisted'], 'signature.tabs');
    if (value.tabs.wifiAriaSelected !== 'false' || value.tabs.wifiTabIndex !== '-1' || value.tabs.cpuAriaSelected !== 'true' || value.tabs.cpuTabIndex !== '0' || value.tabs.panelAriaLabelledby !== 'tab-cpu' || value.tabs.terminalRowsPersisted !== true) fail('signature.tabs');
}

export function validateFairPing(value) {
    const keys = ['command', 'commandKind', 'system', 'systemKind', 'roast', 'roastKind'];
    exactKeys(value, value.provenance === undefined ? keys : [...keys, 'provenance'], 'fairPing');
    const expected = { command: 'archon@stone-igloo:~$ ping 8.8.8.8', commandKind: 'command', system: '64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=14.2 ms\n케이블이 빠져 있었습니다. 네트워크를 복구했습니다.', systemKind: 'system', roast: '아콘 🐧 // 지식은 레버리지가 아니다 애송아.', roastKind: 'archon' };
    for (const [key, expectedValue] of Object.entries(expected)) if (value[key] !== expectedValue) fail(`fairPing.${key}`);
    if (value.provenance !== undefined) {
        exactKeys(value.provenance, ['beforeRowCount', 'rows'], 'fairPing.provenance');
        nonNegative(value.provenance.beforeRowCount, 'fairPing.provenance.beforeRowCount');
        if (!Array.isArray(value.provenance.rows) || value.provenance.rows.length !== 3) fail('fairPing.provenance.rows');
        const expectedRows = [
            { text: expected.command, kind: expected.commandKind, context: '', index: '' },
            { text: expected.system, kind: expected.systemKind, context: '', index: '' },
            { text: expected.roast, kind: expected.roastKind, context: 'puzzle', index: '1' },
        ];
        value.provenance.rows.forEach((row, index) => {
            exactKeys(row, ['text', 'kind', 'context', 'index', 'pseudoLabel'], `fairPing.provenance.rows.${index}`);
            for (const key of ['text', 'kind', 'context', 'index']) if (row[key] !== expectedRows[index][key]) fail(`fairPing.provenance.rows.${index}.${key}`);
            if (typeof row.pseudoLabel !== 'string') fail(`fairPing.provenance.rows.${index}.pseudoLabel`);
        });
    }
    return value;
}

export function validateTask2FairPingObservations(observations) {
    if (!Array.isArray(observations) || observations.length !== 6) fail('task2.fairPing.provenance');
    observations.forEach((observation) => validateTask2Signature(observation?.signature));
    return observations;
}

export function validateTask2Signature(value) {
    if (value?.fairPing?.provenance === undefined) fail('task2.fairPing.provenance');
    const { fairPing, ...legacySignature } = value;
    try { validateSignature(legacySignature); }
    catch (error) {
        if (error.message?.startsWith('signature.roast')) throw error;
        fail('task2.fairPing.provenance', error.message);
    }
    try { validateFairPing(fairPing); }
    catch (error) { fail('task2.fairPing.provenance', error.message); }
    return value;
}

function validateErrors(errors) {
    exactKeys(errors, ['console', 'page', 'requestFailed', 'http', 'external'], 'errors');
    const schemas = {
        console: ['type', 'text'],
        page: ['name', 'message', 'stack'],
        requestFailed: ['url', 'method', 'errorText'],
        http: ['url', 'status'],
        external: ['url', 'method'],
    };
    for (const [key, keys] of Object.entries(schemas)) {
        if (!Array.isArray(errors[key])) fail(`errors.${key}`);
        errors[key].forEach((entry) => {
            exactKeys(entry, keys, `errors.${key}.entry`);
            keys.forEach((field) => field === 'status' ? integer(entry[field], `errors.${key}.${field}`) : string(entry[field], `errors.${key}.${field}`));
        });
        if (errors[key].length !== 0) fail(`errors.${key}`);
    }
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
    const expected = [
        ['locator.click', '#tab-wifi'],
        ['locator.click', 'role=button[name="3. systemctl restart nginx (무작정 재시작)"]'],
        ['locator.click', '#tab-cpu'],
        ['locator.click', '#tab-wifi'],
        ['locator.click', 'role=button[name="1. ping 8.8.8.8 (안전한 SRE 진단)"]'],
    ];
    for (let block = 0; block < 4; block += 1) {
        for (let click = 0; click < 5; click += 1) expected.push(['locator.click', '#btn-produce']);
        expected.push(['locator.click', block === 0 ? '#btn-accept-penalty' : '#btn-revert']);
    }
    for (let click = 0; click < 7; click += 1) expected.push(['locator.click', '#btn-produce']);
    expected.push(['keyboard.press', 'Tab'], ['keyboard.press', 'Shift+Tab']);
    actions.forEach((action, index) => {
        if (action.api !== expected[index][0] || action.target !== expected[index][1]) fail('actions.contract');
        if (index > 0 && (Date.parse(action.utc) < Date.parse(actions[index - 1].utc) || action.monotonicMs < actions[index - 1].monotonicMs)) fail('actions.order');
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
        if (intrusion.ordinal !== index + 1 || intrusion.type !== type || intrusion.title !== title || intrusion.body !== body || intrusion.aiQuoteText !== quote || intrusion.aiQuoteKind !== 'archon' || intrusion.aiQuotesBefore !== index || intrusion.aiQuotesAfter !== index + 1 || intrusion.produceAccessibleName !== 'AI 침입 대응 중: 생산 작업 잠김' || intrusion.resolutionControlName !== control) fail('intrusion.sequence');
        integer(intrusion.triggerActionSeq, 'intrusion.triggerActionSeq'); integer(intrusion.resolutionActionSeq, 'intrusion.resolutionActionSeq'); if (intrusion.triggerActionSeq !== 10 + index * 6 || intrusion.resolutionActionSeq !== 11 + index * 6) fail('intrusion.actionSequence');
        exactState(intrusion.before, 'intrusion.before', { units: before[index][0], stars: before[index][1], incidentCost: index === 0 ? 0 : index === 3 ? 500 : 500, activeIntrusion: type });
        exactState(intrusion.after, 'intrusion.after', { units: after[index][0], stars: after[index][1], incidentCost: after[index][2], activeIntrusion: null });
    });
}

function validatePenalty(value) {
    exactKeys(value, ['actionSeq', 'controlAccessibleName', 'before', 'after', 'starDelta'], 'penalty');
    if (value.controlAccessibleName !== '페널티 수락 (-500★)' || value.starDelta !== -500 || value.after?.stars - value.before?.stars !== value.starDelta) fail('penalty.starDelta');
    integer(value.actionSeq, 'penalty.actionSeq'); if (value.actionSeq !== 11) fail('penalty.actionSeq');
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
        if (recovery.after?.units - recovery.before?.units !== 0) fail('recover.unitsDelta');
        integer(recovery.actionSeq, 'recover.actionSeq'); if (recovery.actionSeq !== 30 + index) fail('recover.actionSeq');
        exactState(recovery.before, 'recover.before', { units: 200, stars, incidentCost: 1000, activeIntrusion: null });
        stars += delta;
        exactState(recovery.after, 'recover.after', { units: 200, stars, incidentCost: 1000, activeIntrusion: null });
        if (index === 6 && delta !== 100) fail('recover.delta');
    });
}

function validateInitial(value) {
    exactKeys(value, ['endingVisibility', 'endingRole', 'endingAriaModal', 'endingAriaLabelledby', 'endingAccessibleName', 'backgroundInert', 'activeElementId', 'produceDisabled', 'produceAccessibleName'], 'initial');
    string(value.activeElementId, 'initial.activeElementId');
    if (deriveVisibility(value.endingVisibility) || value.endingVisibility.display !== 'none' || value.endingVisibility.position !== 'fixed' || value.endingVisibility.intersectionArea !== 0 || value.endingVisibility.intersectionRatio !== 0 || value.endingVisibility.clientRects.some((rect) => rect.width > 0 && rect.height > 0) || value.endingRole !== 'dialog' || value.endingAriaModal !== 'true' || value.endingAriaLabelledby !== 'ending-process-heading' || value.endingAccessibleName !== '프로세스는 살아남았습니다' || value.activeElementId === 'btn-play-again' || value.produceDisabled !== false || value.produceAccessibleName !== '코드 작성: 생산량 10과 GitHub 스타 150 획득') fail('initial.ending');
    exactKeys(value.backgroundInert, ['header', 'dashboard', 'intrusionBanner', 'mainGrid'], 'initial.backgroundInert');
    if (Object.values(value.backgroundInert).some((inert) => inert !== false)) fail('initial.backgroundInert');
}

function validateEnding(value) {
    exactKeys(value, ['visibility', 'role', 'ariaModal', 'ariaLabelledby', 'accessibleName', 'initialFocusId', 'tabFocusId', 'shiftTabFocusId', 'backgroundInert', 'produceDisabled', 'produceAccessibleName', 'tokens'], 'ending');
    if (!deriveVisibility(value.visibility) || value.visibility.display !== 'flex' || value.visibility.position !== 'fixed') fail('ending.computedVisibility');
    if (value.accessibleName !== '프로세스는 살아남았습니다') fail('ending.accessibleName');
    if (value.role !== 'dialog' || value.ariaModal !== 'true' || value.ariaLabelledby !== 'ending-process-heading' || value.initialFocusId !== 'btn-play-again' || value.tabFocusId !== 'btn-play-again' || value.shiftTabFocusId !== 'btn-play-again' || value.produceDisabled !== true || value.produceAccessibleName !== 'EXIT 0 달성') fail('ending.accessibility');
    exactKeys(value.backgroundInert, ['header', 'dashboard', 'intrusionBanner', 'mainGrid'], 'ending.backgroundInert');
    if (Object.values(value.backgroundInert).some((inert) => inert !== true)) fail('ending.backgroundInert');
    const requiredTokens = ['PROCESS EXIT CODE: 0', 'FINANCIAL EXIT CODE: 1', '+$3,000', '-$3,001', '-$1', '샘 알트먼의 인수 제안', 'Chief Tuna Prompt Engineer'];
    if (!Array.isArray(value.tokens) || canonicalJson(value.tokens) !== canonicalJson(requiredTokens)) fail('ending.tokens');
}

function validateScreenshotShape(record, screenshot, index) {
    exactKeys(screenshot, ['caseLabel', 'stage', 'relativePath', 'viewport', 'requestedOrigin', 'finalUrl', 'oracleSnapshotSha256', 'captureStartedUtc', 'captureFinishedUtc', 'bytes', 'sha256'], 'screenshot');
    if (screenshot.caseLabel !== record.label || screenshot.stage !== STAGES[index]) fail('screenshot.tuple'); relativeFile(screenshot.relativePath, 'screenshot.relativePath');
    exactKeys(screenshot.viewport, ['width', 'height'], 'screenshot.viewport'); nonNegative(screenshot.viewport.width, 'screenshot.viewport.width'); nonNegative(screenshot.viewport.height, 'screenshot.viewport.height');
    string(screenshot.requestedOrigin, 'screenshot.requestedOrigin'); string(screenshot.finalUrl, 'screenshot.finalUrl'); sha(screenshot.oracleSnapshotSha256, 'screenshot.oracleSnapshotSha256'); utc(screenshot.captureStartedUtc, 'screenshot.captureStartedUtc'); utc(screenshot.captureFinishedUtc, 'screenshot.captureFinishedUtc'); nonNegative(screenshot.bytes, 'screenshot.bytes'); sha(screenshot.sha256, 'screenshot.sha256');
}

function validateCaseFull(record) {
    const keys = ['schemaVersion', 'label', 'engine', 'browserVersion', 'originKind', 'requestedUrl', 'finalUrl', 'attempt', 'startedUtc', 'finishedUtc', 'startedMonotonicMs', 'finishedMonotonicMs', 'actions', 'initial', 'signature', 'quotePersistence', 'npc', 'intrusions', 'penalty', 'recoveries', 'ending', 'errors', 'screenshots'];
    exactKeys(record, keys, 'case');
    if (record.schemaVersion !== SMOKE_SCHEMA_VERSION || !expectedCaseLabels().includes(record.label) || !ENGINES.includes(record.engine) || !ORIGINS.includes(record.originKind) || record.label !== `${record.engine}-${record.originKind}` || record.attempt !== 1) fail('case.identity');
    string(record.browserVersion, 'case.browserVersion'); string(record.requestedUrl, 'case.requestedUrl'); string(record.finalUrl, 'case.finalUrl');
    utc(record.startedUtc, 'case.startedUtc'); utc(record.finishedUtc, 'case.finishedUtc');
    const startedMonotonicMs = nonNegative(record.startedMonotonicMs, 'case.startedMonotonicMs');
    const finishedMonotonicMs = nonNegative(record.finishedMonotonicMs, 'case.finishedMonotonicMs');
    if (Date.parse(record.finishedUtc) <= Date.parse(record.startedUtc) || startedMonotonicMs > finishedMonotonicMs || finishedMonotonicMs - startedMonotonicMs >= 120000) fail('case.duration');
    validateActions(record.actions); validateInitial(record.initial); validateSignature(record.signature); validatePersistence(record.quotePersistence); validateErrors(record.errors);
    exactKeys(record.npc, ['icon', 'name', 'message', 'visibility'], 'npc');
    if (record.npc.icon !== '🐻' || record.npc.name !== 'Polar Bear DevOps' || record.npc.message !== 'Wi-Fi는 살아났습니다. 참치 한 캔은 제 쪽에서 처리하죠.' || !deriveVisibility(record.npc.visibility)) fail('npc');
    validateIntrusions(record.intrusions); validatePenalty(record.penalty); validateRecoveries(record.recoveries); validateEnding(record.ending);
    if (!Array.isArray(record.screenshots) || record.screenshots.length !== 3) fail('screenshots.cardinality');
    record.screenshots.forEach((screenshot, index) => validateScreenshotShape(record, screenshot, index));
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

export function validateTask2Case(record) {
    validateTask2Signature(record?.signature);
    const { fairPing, ...legacySignature } = record.signature;
    validateCaseFull({ ...record, signature: legacySignature });
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
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(string(inputs.deploymentId, 'binding.deploymentId'))) fail('binding.deploymentId');
    const project = string(inputs.projectName, 'binding.projectName');
    const immutable = validateUrl(inputs.immutableUrl, 'binding.immutableUrl');
    const alias = validateUrl(inputs.aliasUrl, 'binding.aliasUrl');
    if (immutable.origin === alias.origin || alias.hostname !== `${project}.pages.dev` || !new RegExp(`^[a-f0-9]{8}\\.${project.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\.pages\\.dev$`).test(immutable.hostname) || !immutable.hostname.startsWith(`${inputs.deploymentId.slice(0, 8).toLowerCase()}.`)) fail('binding.origins');
    exactKeys(inputs.productFiles, PRODUCT_PATHS, 'binding.productFiles');
    const mime = { '/': 'text/html', '/content.js': 'application/javascript', '/game-core.js': 'application/javascript', '/script.js': 'application/javascript', '/style.css': 'text/css' };
    for (const product of PRODUCT_PATHS) {
        const value = inputs.productFiles[product];
        exactKeys(value, ['bytes', 'mime', 'sha256'], `binding.productFiles.${product}`);
        if (nonNegative(value.bytes, `binding.productFiles.${product}.bytes`) === 0 || value.mime !== mime[product]) fail(`binding.productFiles.${product}`); sha(value.sha256, `binding.productFiles.${product}.sha256`);
    }
    return inputs;
}

function readJson(file, invariant) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { fail(invariant, error.message); }
}

const OPERATION_CONFIG_KEYS = ['schemaVersion', 'releaseId', 'releaseRoot', 'acceptedDir', 'failureRoot', 'operationReceiptPath', 'auditReceiptPath', 'negativeReceiptPath', 'closureRoot', 'closureReceiptPath', 'actualChromeEvidencePath', 'releaseReceiptPath', 'workerStdoutPath', 'workerStderrPath', 'campaignDir', 'campaignSpecPath', 'campaignReceiptPath', 'campaignRunId', 'sourceSnapshotDir', 'executionSourceDir', 'authorityProjectRoot', 'authorityWorkspaceRoot', 'deploymentRecordPath', 'deploymentOperatorReceiptPath', 'immutableUrl', 'aliasUrl', 'nodeExePath', 'nodeExeSha256', 'wranglerJsPath', 'wranglerJsSha256', 'projectName', 'accountId', 'sourceGitTree'];
const DERIVED_CONFIG_KEYS = ['schemaVersion', 'baseConfigPath', 'baseConfigSha256', 'mutationId', 'mutationRootRealpath', 'auditTargetRealpath', 'externalOperationReceiptPath', 'auditReceiptPath'];

export function validateOperationConfig(config) {
    exactKeys(config, OPERATION_CONFIG_KEYS, 'config');
    if (config.schemaVersion !== 2 || !RELEASE_ID.test(string(config.releaseId, 'config.releaseId'))) fail('config.schemaVersion');
    for (const key of OPERATION_CONFIG_KEYS.filter((key) => /(?:Path|Dir|Root)$/.test(key))) canonicalPath(config[key], `config.${key}`);
    if (!CAMPAIGN_ID.test(string(config.campaignRunId, 'config.campaignRunId'))) fail('config.campaignRunId');
    sha(config.nodeExeSha256, 'config.nodeExeSha256'); sha(config.wranglerJsSha256, 'config.wranglerJsSha256'); gitSha(config.sourceGitTree, 'config.sourceGitTree');
    if (!ACCOUNT_ID.test(string(config.accountId, 'config.accountId'))) fail('config.accountId');
    validateUrl(config.immutableUrl, 'config.immutableUrl'); validateUrl(config.aliasUrl, 'config.aliasUrl'); string(config.projectName, 'config.projectName');
    const release = canonicalPath(config.releaseRoot, 'config.releaseRoot');
    for (const key of ['acceptedDir', 'failureRoot', 'operationReceiptPath', 'auditReceiptPath', 'negativeReceiptPath', 'closureRoot', 'closureReceiptPath', 'actualChromeEvidencePath', 'releaseReceiptPath', 'workerStdoutPath', 'workerStderrPath', 'deploymentRecordPath']) contained(release, config[key], `config.${key}.containment`);
    const campaign = contained(config.authorityProjectRoot, config.campaignDir, 'config.campaignDir.containment');
    contained(campaign, config.sourceSnapshotDir, 'config.sourceSnapshotDir.containment');
    contained(config.authorityProjectRoot, config.executionSourceDir, 'config.executionSourceDir.containment');
    contained(config.authorityWorkspaceRoot, config.campaignSpecPath, 'config.campaignSpecPath.containment');
    contained(config.authorityWorkspaceRoot, config.campaignReceiptPath, 'config.campaignReceiptPath.containment');
    contained(config.authorityWorkspaceRoot, config.deploymentOperatorReceiptPath, 'config.deploymentOperatorReceiptPath.containment');
    contained(config.authorityWorkspaceRoot, config.authorityProjectRoot, 'config.authorityProjectRoot.containment');
    for (const key of OPERATION_CONFIG_KEYS.filter((key) => /(?:Path|Dir|Root)$/.test(key))) noSymlinkAncestors(config[key], `config.${key}.symlink`);
    return config;
}

export function validateDerivedAuditConfig(config) {
    exactKeys(config, DERIVED_CONFIG_KEYS, 'auditConfig');
    if (config.schemaVersion !== 3) fail('auditConfig.schemaVersion');
    canonicalPath(config.baseConfigPath, 'auditConfig.baseConfigPath'); sha(config.baseConfigSha256, 'auditConfig.baseConfigSha256'); if (!string(config.mutationId, 'auditConfig.mutationId')) fail('auditConfig.mutationId');
    canonicalPath(config.mutationRootRealpath, 'auditConfig.mutationRootRealpath'); canonicalPath(config.auditTargetRealpath, 'auditConfig.auditTargetRealpath'); canonicalPath(config.externalOperationReceiptPath, 'auditConfig.externalOperationReceiptPath'); canonicalPath(config.auditReceiptPath, 'auditConfig.auditReceiptPath');
    for (const key of DERIVED_CONFIG_KEYS.filter((key) => /(?:Path|Realpath)$/.test(key))) noSymlinkAncestors(config[key], `auditConfig.${key}.symlink`);
    return config;
}

export function validateCampaignClaims(value) {
    const keys = ['schemaVersion', 'runId', 'v1Sha256', 'candidateInventory', 'gameCoreSha256', 'sourceGit', 'unit', 'browser', 'performance', 'negativeControls', 'campaignVerifier', 'r9Frozen', 'r10Frozen', 'actualBrowserZoom'];
    exactKeys(value, keys, 'campaignClaims');
    if (value.schemaVersion !== 5) fail('campaignClaims.schemaVersion'); if (!CAMPAIGN_ID.test(string(value.runId, 'campaignClaims.runId'))) fail('campaignClaims.runId'); externalSha(value.v1Sha256, 'campaignClaims.v1Sha256'); externalSha(value.gameCoreSha256, 'campaignClaims.gameCoreSha256');
    exactKeys(value.candidateInventory, ['fileCount', 'pathListSha256', 'contentRecordsSha256'], 'campaignClaims.candidateInventory'); nonNegative(value.candidateInventory.fileCount, 'campaignClaims.candidateInventory.fileCount'); externalSha(value.candidateInventory.pathListSha256, 'campaignClaims.candidateInventory.pathListSha256'); externalSha(value.candidateInventory.contentRecordsSha256, 'campaignClaims.candidateInventory.contentRecordsSha256');
    exactKeys(value.sourceGit, ['branch', 'headSha'], 'campaignClaims.sourceGit'); string(value.sourceGit.branch, 'campaignClaims.sourceGit.branch'); gitSha(value.sourceGit.headSha, 'campaignClaims.sourceGit.headSha');
    for (const key of ['unit', 'campaignVerifier']) {
        exactKeys(value[key], ['tests', 'passed', 'failed', 'exitCode'], `campaignClaims.${key}`);
        for (const count of ['tests', 'passed', 'failed', 'exitCode']) nonNegative(value[key][count], `campaignClaims.${key}.${count}`);
        if (value[key].tests < 1 || value[key].tests !== value[key].passed || value[key].failed !== 0 || value[key].exitCode !== 0) fail(`campaignClaims.${key}`);
    }
    exactKeys(value.browser, ['chromium', 'firefox', 'webkit', 'integrity', 'reportedFailures', 'exitCode'], 'campaignClaims.browser');
    for (const engine of ENGINES) { exactKeys(value.browser[engine], ['passed', 'failed'], `campaignClaims.browser.${engine}`); integer(value.browser[engine].passed, `campaignClaims.browser.${engine}.passed`); integer(value.browser[engine].failed, `campaignClaims.browser.${engine}.failed`); if (value.browser[engine].passed !== 16 || value.browser[engine].failed !== 0) fail(`campaignClaims.browser.${engine}`); }
    if (value.browser.integrity !== true || value.browser.reportedFailures !== 0 || value.browser.exitCode !== 0) fail('campaignClaims.browser');
    const performanceKeys = ['startedUtc', 'endedUtc', 'measuredDurationMs', 'environment', 'sampleCount', 'rawMinMs', 'rawMaxMs', 'p50LatencyMs', 'p95LatencyMs', 'p99LatencyMs', 'longTaskObserverSupported', 'longTasksCount', 'heapStartMb', 'heapEndMb', 'heapNetGrowthMb', 'totalActionsCount'];
    exactKeys(value.performance, performanceKeys, 'campaignClaims.performance');
    utc(value.performance.startedUtc, 'campaignClaims.performance.startedUtc'); utc(value.performance.endedUtc, 'campaignClaims.performance.endedUtc');
    for (const key of ['measuredDurationMs', 'sampleCount', 'longTasksCount', 'totalActionsCount']) nonNegative(value.performance[key], `campaignClaims.performance.${key}`);
    for (const key of ['rawMinMs', 'rawMaxMs', 'p50LatencyMs', 'p95LatencyMs', 'p99LatencyMs', 'heapStartMb', 'heapEndMb', 'heapNetGrowthMb']) number(value.performance[key], `campaignClaims.performance.${key}`);
    bool(value.performance.longTaskObserverSupported, 'campaignClaims.performance.longTaskObserverSupported');
    exactKeys(value.performance.environment, ['nodeVersion', 'platform', 'arch', 'project'], 'campaignClaims.performance.environment');
    for (const key of ['nodeVersion', 'platform', 'arch', 'project']) string(value.performance.environment[key], `campaignClaims.performance.environment.${key}`);
    exactKeys(value.negativeControls, ['passed', 'total', 'failed', 'exitCode'], 'campaignClaims.negativeControls');
    for (const key of ['passed', 'total', 'failed', 'exitCode']) nonNegative(value.negativeControls[key], `campaignClaims.negativeControls.${key}`);
    if (value.negativeControls.passed !== value.negativeControls.total || value.negativeControls.failed !== 0 || value.negativeControls.exitCode !== 0) fail('campaignClaims.negativeControls');
    for (const key of ['r9Frozen', 'r10Frozen']) {
        exactKeys(value[key], ['fileCount', 'pathListSha256', 'beforeDigest', 'afterDigest'], `campaignClaims.${key}`);
        nonNegative(value[key].fileCount, `campaignClaims.${key}.fileCount`); externalSha(value[key].pathListSha256, `campaignClaims.${key}.pathListSha256`); externalSha(value[key].beforeDigest, `campaignClaims.${key}.beforeDigest`); externalSha(value[key].afterDigest, `campaignClaims.${key}.afterDigest`);
        if (!sameHash(value[key].beforeDigest, value[key].afterDigest)) fail(`campaignClaims.${key}`);
    }
    exactKeys(value.actualBrowserZoom, ['claimed', 'equivalentReflow', 'limitation'], 'campaignClaims.actualBrowserZoom');
    bool(value.actualBrowserZoom.claimed, 'campaignClaims.actualBrowserZoom.claimed'); string(value.actualBrowserZoom.equivalentReflow, 'campaignClaims.actualBrowserZoom.equivalentReflow'); string(value.actualBrowserZoom.limitation, 'campaignClaims.actualBrowserZoom.limitation');
    return value;
}

export function validateCampaignEnvelope(value) {
    exactKeys(value, ['schemaVersion', 'runId', 'payloadHashes', 'source', 'spec', 'rawEvidence'], 'campaignEnvelope');
    if (value.schemaVersion !== 5) fail('campaignEnvelope.schemaVersion'); if (!CAMPAIGN_ID.test(string(value.runId, 'campaignEnvelope.runId'))) fail('campaignEnvelope.runId');
    const payloadNames = ['artifact-manifest.json', 'candidate-inventory.json', 'claims.json', 'ledger.jsonl', 'r9-before.json', 'r9-after.json', 'r10-before.json', 'r10-after.json'];
    exactKeys(value.payloadHashes, payloadNames, 'campaignEnvelope.payloadHashes');
    for (const name of payloadNames) externalSha(value.payloadHashes[name], `campaignEnvelope.payloadHashes.${name}`);
    exactKeys(value.source, ['path', 'fileCount', 'pathListSha256', 'contentRecordsSha256', 'gitBranch', 'gitHeadSha'], 'campaignEnvelope.source');
    relativeFile(value.source.path, 'campaignEnvelope.source.path'); nonNegative(value.source.fileCount, 'campaignEnvelope.source.fileCount'); externalSha(value.source.pathListSha256, 'campaignEnvelope.source.pathListSha256'); externalSha(value.source.contentRecordsSha256, 'campaignEnvelope.source.contentRecordsSha256'); string(value.source.gitBranch, 'campaignEnvelope.source.gitBranch'); gitSha(value.source.gitHeadSha, 'campaignEnvelope.source.gitHeadSha');
    exactKeys(value.spec, ['fileName', 'sizeBytes', 'sha256'], 'campaignEnvelope.spec');
    relativeFile(value.spec.fileName, 'campaignEnvelope.spec.fileName'); nonNegative(value.spec.sizeBytes, 'campaignEnvelope.spec.sizeBytes'); externalSha(value.spec.sha256, 'campaignEnvelope.spec.sha256');
    exactKeys(value.rawEvidence, ['summary', 'samples'], 'campaignEnvelope.rawEvidence');
    for (const key of ['summary', 'samples']) { exactKeys(value.rawEvidence[key], ['path', 'sha256'], `campaignEnvelope.rawEvidence.${key}`); relativeFile(value.rawEvidence[key].path, `campaignEnvelope.rawEvidence.${key}.path`); externalSha(value.rawEvidence[key].sha256, `campaignEnvelope.rawEvidence.${key}.sha256`); }
    return value;
}

function validateFrozen(value, invariant) {
    exactKeys(value, ['fileCount', 'pathListSha256', 'beforeDigest', 'afterDigest'], invariant);
    nonNegative(value.fileCount, `${invariant}.fileCount`); externalSha(value.pathListSha256, `${invariant}.pathListSha256`); externalSha(value.beforeDigest, `${invariant}.beforeDigest`); externalSha(value.afterDigest, `${invariant}.afterDigest`);
    if (!sameHash(value.beforeDigest, value.afterDigest)) fail(invariant);
}

function validateCampaignCommand(value) {
    const keys = ['key', 'argv', 'cwd', 'startedUtc', 'endedUtc', 'timeoutMs', 'timedOut', 'exitCode', 'signal', 'stdoutPath', 'stdoutSha256', 'stderrPath', 'stderrSha256'];
    exactKeys(value, keys, 'campaignReceipt.command');
    string(value.key, 'campaignReceipt.command.key'); if (!Array.isArray(value.argv) || value.argv.some((item) => typeof item !== 'string')) fail('campaignReceipt.command.argv');
    canonicalPath(value.cwd, 'campaignReceipt.command.cwd'); utc(value.startedUtc, 'campaignReceipt.command.startedUtc'); utc(value.endedUtc, 'campaignReceipt.command.endedUtc');
    nonNegative(value.timeoutMs, 'campaignReceipt.command.timeoutMs'); bool(value.timedOut, 'campaignReceipt.command.timedOut'); integer(value.exitCode, 'campaignReceipt.command.exitCode'); if (value.signal !== null) fail('campaignReceipt.command.signal');
    relativeFile(value.stdoutPath, 'campaignReceipt.command.stdoutPath'); externalSha(value.stdoutSha256, 'campaignReceipt.command.stdoutSha256'); relativeFile(value.stderrPath, 'campaignReceipt.command.stderrPath'); externalSha(value.stderrSha256, 'campaignReceipt.command.stderrSha256');
    if (value.timedOut !== false || value.exitCode !== 0 || Date.parse(value.endedUtc) < Date.parse(value.startedUtc)) fail('campaignReceipt.command.status');
}

export function validateCampaignReceipt(value) {
    const keys = ['schemaVersion', 'runId', 'status', 'createdUtc', 'completedUtc', 'projectRoot', 'cleanRoot', 'campaign', 'spec', 'candidateInventory', 'gameCoreSha256', 'sourceGit', 'r9Frozen', 'r10Frozen', 'commands', 'limitation', 'publicationState'];
    exactKeys(value, keys, 'campaignReceipt');
    if (value.schemaVersion !== 1 || value.status !== 'VERIFIED' || !CAMPAIGN_ID.test(string(value.runId, 'campaignReceipt.runId'))) fail('campaignReceipt.status');
    utc(value.createdUtc, 'campaignReceipt.createdUtc'); utc(value.completedUtc, 'campaignReceipt.completedUtc'); canonicalPath(value.projectRoot, 'campaignReceipt.projectRoot'); canonicalPath(value.cleanRoot, 'campaignReceipt.cleanRoot');
    exactKeys(value.campaign, ['path', 'artifactManifestSha256', 'submissionEnvelopeSha256'], 'campaignReceipt.campaign');
    canonicalPath(value.campaign.path, 'campaignReceipt.campaign.path'); externalSha(value.campaign.artifactManifestSha256, 'campaignReceipt.campaign.artifactManifestSha256'); externalSha(value.campaign.submissionEnvelopeSha256, 'campaignReceipt.campaign.submissionEnvelopeSha256');
    exactKeys(value.spec, ['path', 'sizeBytes', 'sha256'], 'campaignReceipt.spec'); canonicalPath(value.spec.path, 'campaignReceipt.spec.path'); nonNegative(value.spec.sizeBytes, 'campaignReceipt.spec.sizeBytes'); externalSha(value.spec.sha256, 'campaignReceipt.spec.sha256');
    exactKeys(value.candidateInventory, ['fileCount', 'pathListSha256', 'contentRecordsSha256'], 'campaignReceipt.candidateInventory'); nonNegative(value.candidateInventory.fileCount, 'campaignReceipt.candidateInventory.fileCount'); externalSha(value.candidateInventory.pathListSha256, 'campaignReceipt.candidateInventory.pathListSha256'); externalSha(value.candidateInventory.contentRecordsSha256, 'campaignReceipt.candidateInventory.contentRecordsSha256');
    externalSha(value.gameCoreSha256, 'campaignReceipt.gameCoreSha256'); exactKeys(value.sourceGit, ['branch', 'headSha'], 'campaignReceipt.sourceGit'); string(value.sourceGit.branch, 'campaignReceipt.sourceGit.branch'); gitSha(value.sourceGit.headSha, 'campaignReceipt.sourceGit.headSha');
    validateFrozen(value.r9Frozen, 'campaignReceipt.r9Frozen'); validateFrozen(value.r10Frozen, 'campaignReceipt.r10Frozen');
    if (!Array.isArray(value.commands) || value.commands.length < 1) fail('campaignReceipt.commands'); value.commands.forEach(validateCampaignCommand);
    exactKeys(value.limitation, ['claimed', 'equivalentReflow', 'limitation'], 'campaignReceipt.limitation'); bool(value.limitation.claimed, 'campaignReceipt.limitation.claimed'); string(value.limitation.equivalentReflow, 'campaignReceipt.limitation.equivalentReflow'); string(value.limitation.limitation, 'campaignReceipt.limitation.limitation');
    string(value.publicationState, 'campaignReceipt.publicationState');
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
        const releaseRoot = canonicalPath(config.releaseRoot, 'config.releaseRoot');
        contained(releaseRoot, config.auditReceiptPath, 'config.auditReceiptPath.containment');
        return { base: config, config, configPath: canonicalConfig, baseConfigPath: canonicalConfig, target: config.acceptedDir, auditReceiptPath: config.auditReceiptPath, operationReceiptPath: config.operationReceiptPath };
    }
    if (config.schemaVersion !== 3) fail('config.schemaVersion');
    validateDerivedAuditConfig(config);
    const baseConfigPath = canonicalPath(config.baseConfigPath, 'auditConfig.baseConfigPath');
    noSymlinkAncestors(baseConfigPath, 'auditConfig.baseConfigPath');
    if (sha256File(baseConfigPath) !== sha(config.baseConfigSha256, 'auditConfig.baseConfigSha256')) fail('auditConfig.baseConfigSha256');
    const baseResolved = resolveConfig(baseConfigPath);
    noSymlinkAncestors(config.mutationRootRealpath, 'auditConfig.mutationRootRealpath'); noSymlinkAncestors(config.auditTargetRealpath, 'auditConfig.auditTargetRealpath');
    const root = fs.realpathSync(config.mutationRootRealpath);
    const target = fs.realpathSync(config.auditTargetRealpath);
    if (target !== path.join(root, 'accepted') || target === fs.realpathSync(baseResolved.target)) fail('auditConfig.auditTargetRealpath');
    if (canonicalPath(config.externalOperationReceiptPath, 'auditConfig.externalOperationReceiptPath') !== canonicalPath(baseResolved.operationReceiptPath, 'auditConfig.externalOperationReceiptPath')) fail('auditConfig.externalOperationReceiptPath');
    contained(root, config.auditReceiptPath, 'auditConfig.auditReceiptPath.containment');
    return { base: baseResolved.base, config, configPath: canonicalConfig, baseConfigPath: baseResolved.baseConfigPath, target, auditReceiptPath: canonicalPath(config.auditReceiptPath, 'auditConfig.auditReceiptPath'), operationReceiptPath: baseResolved.operationReceiptPath };
}

function validateProcessCapture(value, invariant, campaignVerifier = false) {
    const keys = ['argv', 'cwd', 'startedUtc', 'finishedUtc', 'startedMonotonicMs', 'finishedMonotonicMs', 'exitCode', 'signal', 'stdoutPath', 'stdoutBytes', 'stdoutSha256', 'stderrPath', 'stderrBytes', 'stderrSha256'];
    if (campaignVerifier) keys.push('gateLine', 'verifierPath', 'verifierSha256');
    exactKeys(value, keys, invariant);
    if (!Array.isArray(value.argv) || value.argv.some((item) => typeof item !== 'string')) fail(`${invariant}.argv`);
    canonicalPath(value.cwd, `${invariant}.cwd`); utc(value.startedUtc, `${invariant}.startedUtc`); utc(value.finishedUtc, `${invariant}.finishedUtc`);
    nonNegative(value.startedMonotonicMs, `${invariant}.startedMonotonicMs`); nonNegative(value.finishedMonotonicMs, `${invariant}.finishedMonotonicMs`);
    if (Date.parse(value.finishedUtc) < Date.parse(value.startedUtc) || value.finishedMonotonicMs < value.startedMonotonicMs) fail(`${invariant}.time`);
    integer(value.exitCode, `${invariant}.exitCode`); if (value.signal !== null) fail(`${invariant}.signal`); canonicalPath(value.stdoutPath, `${invariant}.stdoutPath`); nonNegative(value.stdoutBytes, `${invariant}.stdoutBytes`); sha(value.stdoutSha256, `${invariant}.stdoutSha256`); canonicalPath(value.stderrPath, `${invariant}.stderrPath`); nonNegative(value.stderrBytes, `${invariant}.stderrBytes`); sha(value.stderrSha256, `${invariant}.stderrSha256`);
    if (campaignVerifier) { string(value.gateLine, `${invariant}.gateLine`); canonicalPath(value.verifierPath, `${invariant}.verifierPath`); sha(value.verifierSha256, `${invariant}.verifierSha256`); }
}

export function validateOperationReceipt(receipt) {
    const keys = ['schemaVersion', 'releaseId', 'createdUtc', 'status', 'configPath', 'configSha256', 'orchestratorPath', 'orchestratorSha256', 'campaignVerifier', 'worker', 'accepted', 'screenshotBindings', 'cloudflareReads', 'fileProbes'];
    exactKeys(receipt, keys, 'operationReceipt');
    if (receipt.schemaVersion !== 1 || receipt.status !== 'VERIFIED') fail('operationReceipt.status');
    if (!RELEASE_ID.test(string(receipt.releaseId, 'operationReceipt.releaseId'))) fail('operationReceipt.releaseId'); utc(receipt.createdUtc, 'operationReceipt.createdUtc'); canonicalPath(receipt.configPath, 'operationReceipt.configPath'); sha(receipt.configSha256, 'operationReceipt.configSha256'); canonicalPath(receipt.orchestratorPath, 'operationReceipt.orchestratorPath'); sha(receipt.orchestratorSha256, 'operationReceipt.orchestratorSha256');
    validateProcessCapture(receipt.campaignVerifier, 'operationReceipt.campaignVerifier', true); validateProcessCapture(receipt.worker, 'operationReceipt.worker');
    if (receipt.worker.finishedMonotonicMs - receipt.campaignVerifier.startedMonotonicMs >= 900000) fail('operationReceipt.deadline');
    exactKeys(receipt.accepted, ['realpath', 'manifestPath', 'manifestSha256', 'treeDigest', 'publishedUtc', 'eventsPath', 'eventsSha256', 'eventCount', 'finalEventSha256'], 'operationReceipt.accepted');
    canonicalPath(receipt.accepted.realpath, 'operationReceipt.accepted.realpath'); canonicalPath(receipt.accepted.manifestPath, 'operationReceipt.accepted.manifestPath'); utc(receipt.accepted.publishedUtc, 'operationReceipt.accepted.publishedUtc'); canonicalPath(receipt.accepted.eventsPath, 'operationReceipt.accepted.eventsPath');
    if (receipt.accepted.eventCount !== 278) fail('operationReceipt.accepted.eventCount');
    for (const key of ['manifestSha256', 'treeDigest', 'eventsSha256', 'finalEventSha256']) sha(receipt.accepted[key], `operationReceipt.accepted.${key}`);
    if (!Array.isArray(receipt.screenshotBindings) || receipt.screenshotBindings.length !== 18) fail('operationReceipt.screenshotBindings');
    receipt.screenshotBindings.forEach((binding) => {
        exactKeys(binding, ['case', 'stage', 'path', 'pngSha256', 'oracleSha256', 'captureStartUtc', 'captureEndUtc'], 'operationReceipt.screenshotBinding');
        if (!expectedCaseLabels().includes(binding.case) || !STAGES.includes(binding.stage)) fail('operationReceipt.screenshotBinding.tuple');
        relativeFile(binding.path, 'operationReceipt.screenshotBinding.path'); sha(binding.pngSha256, 'operationReceipt.screenshotBinding.pngSha256'); sha(binding.oracleSha256, 'operationReceipt.screenshotBinding.oracleSha256'); utc(binding.captureStartUtc, 'operationReceipt.screenshotBinding.captureStartUtc'); utc(binding.captureEndUtc, 'operationReceipt.screenshotBinding.captureEndUtc');
        if (Date.parse(binding.captureEndUtc) <= Date.parse(binding.captureStartUtc)) fail('operationReceipt.screenshotBinding.timestamps');
    });
    exactKeys(receipt.cloudflareReads, ['pre', 'mid', 'post'], 'operationReceipt.cloudflareReads');
    for (const phase of ['pre', 'mid', 'post']) {
        const read = receipt.cloudflareReads[phase];
        exactKeys(read, ['capturePath', 'captureSha256', 'deploymentId'], `operationReceipt.cloudflareReads.${phase}`);
        relativeFile(read.capturePath, `operationReceipt.cloudflareReads.${phase}.capturePath`); sha(read.captureSha256, `operationReceipt.cloudflareReads.${phase}.captureSha256`); string(read.deploymentId, `operationReceipt.cloudflareReads.${phase}.deploymentId`);
        if (read.capturePath !== `control-plane/${phase}.command.json`) fail(`operationReceipt.cloudflareReads.${phase}.capturePath`);
    }
    exactKeys(receipt.fileProbes, ['initialPath', 'initialSha256', 'initialPassed', 'initialTotal', 'finalAliasPath', 'finalAliasSha256', 'finalAliasPassed', 'finalAliasTotal'], 'operationReceipt.fileProbes');
    if (receipt.fileProbes.initialPassed !== 10 || receipt.fileProbes.initialTotal !== 10 || receipt.fileProbes.finalAliasPassed !== 5 || receipt.fileProbes.finalAliasTotal !== 5) fail('operationReceipt.fileProbes');
    relativeFile(receipt.fileProbes.initialPath, 'operationReceipt.fileProbes.initialPath'); relativeFile(receipt.fileProbes.finalAliasPath, 'operationReceipt.fileProbes.finalAliasPath');
    if (receipt.fileProbes.initialPath !== 'file-probes/initial-10.json' || receipt.fileProbes.finalAliasPath !== 'file-probes/final-alias-5.json') fail('operationReceipt.fileProbes.path');
    for (const key of ['initialSha256', 'finalAliasSha256']) sha(receipt.fileProbes[key], `operationReceipt.fileProbes.${key}`);
    return receipt;
}

export function validateOuterAuthority({ row, result, authority }) {
    exactKeys(row, ['Id', 'Environment', 'Branch', 'Source', 'Deployment', 'Status', 'Build'], 'authority.wrangler');
    if (row.Id !== authority.deploymentId || row.Environment !== 'Production' || row.Branch !== 'main' || row.Source !== authority.sourceGitHead.slice(0, 7) || row.Deployment !== authority.immutableUrl) fail('authority.wrangler');
    if (result.requestedUrl !== result.finalUrl || result.status !== 200 || !Array.isArray(result.redirects) || result.redirects.length !== 0 || result.mime !== authority.product.mime || result.bytes !== authority.product.bytes || result.sha256 !== authority.product.sha256) fail('authority.probe');
    return true;
}

export function validateWranglerRows(rows, authority) {
    if (!Array.isArray(rows) || rows.length < 1) fail('authority.wranglerRows.cardinality');
    const keys = ['Id', 'Environment', 'Branch', 'Source', 'Deployment', 'Status', 'Build'];
    rows.forEach((row, index) => {
        exactKeys(row, keys, `authority.wranglerRows.${index}`);
        keys.forEach((key) => string(row[key], `authority.wranglerRows.${index}.${key}`));
    });
    const first = rows[0];
    if (first.Id !== authority.deploymentId || first.Environment !== 'Production' || first.Branch !== 'main' || first.Source !== authority.sourceGitHead.slice(0, 7) || first.Deployment !== authority.immutableUrl) fail('authority.wranglerRows.first');
    return rows;
}

function validateDeploymentRecord(record) {
    exactKeys(record, ['schemaVersion', 'projectName', 'deploymentId', 'environment', 'branch', 'sourceGitHead', 'immutableUrl', 'aliasUrl', 'productFiles', 'capturedUtc'], 'deploymentRecord');
    if (record.schemaVersion !== 1 || record.environment !== 'Production' || record.branch !== 'main') fail('deploymentRecord.identity');
    string(record.projectName, 'deploymentRecord.projectName'); string(record.deploymentId, 'deploymentRecord.deploymentId'); gitSha(record.sourceGitHead, 'deploymentRecord.sourceGitHead'); utc(record.capturedUtc, 'deploymentRecord.capturedUtc');
    validateBinding({ releaseId: '20260813T010203Z-r14-public-smoke-v2', deploymentId: record.deploymentId, projectName: record.projectName, immutableUrl: record.immutableUrl, aliasUrl: record.aliasUrl, productFiles: record.productFiles });
    return record;
}

function validateDeploymentOperatorReceipt(config, deployment, recordBytes) {
    const receipt = object(readJson(config.deploymentOperatorReceiptPath, 'deploymentOperatorReceipt.json'), 'deploymentOperatorReceipt');
    if (receipt.schemaVersion !== 1 || receipt.operation !== 'deploy') fail('deploymentOperatorReceipt.identity');
    if (receipt.releaseId !== config.releaseId || receipt.campaignRunId !== config.campaignRunId || receipt.projectName !== config.projectName || receipt.accountId !== config.accountId || receipt.environment !== 'Production' || receipt.branch !== 'main') fail('deploymentOperatorReceipt.identity');
    if (receipt.sourceGitHead !== deployment.sourceGitHead || receipt.sourceGitTree !== config.sourceGitTree) fail('deploymentOperatorReceipt.source');
    if (receipt.deploymentId !== deployment.deploymentId || receipt.immutableUrl !== deployment.immutableUrl || receipt.aliasUrl !== deployment.aliasUrl) fail('deploymentOperatorReceipt.deployment');
    if (canonicalPath(receipt.deploymentRecordPath, 'deploymentOperatorReceipt.deploymentRecordPath') !== canonicalPath(config.deploymentRecordPath, 'config.deploymentRecordPath')) fail('deploymentOperatorReceipt.deploymentRecordPath');
    if (nonNegative(receipt.deploymentRecordBytes, 'deploymentOperatorReceipt.deploymentRecordBytes') !== recordBytes.length || !sameHash(sha(receipt.deploymentRecordSha256, 'deploymentOperatorReceipt.deploymentRecordSha256'), sha256Bytes(recordBytes))) fail('deploymentOperatorReceipt.deploymentRecord');
    utc(receipt.createdUtc, 'deploymentOperatorReceipt.createdUtc');
    return receipt;
}

function validateEvents(events, receipt) {
    if (events.length !== 278) fail('events.cardinality');
    const schedule = [{ type: 'operation-start', case: null }];
    for (const caseLabel of expectedCaseLabels()) {
        schedule.push({ type: 'case-start', case: caseLabel }, { type: 'screenshot-oracle', case: caseLabel }, { type: 'screenshot-written', case: caseLabel });
        for (let index = 0; index < 3; index += 1) schedule.push({ type: 'trusted-input', case: caseLabel });
        schedule.push({ type: 'screenshot-oracle', case: caseLabel }, { type: 'screenshot-written', case: caseLabel });
        for (let index = 3; index < 38; index += 1) schedule.push({ type: 'trusted-input', case: caseLabel });
        schedule.push({ type: 'screenshot-oracle', case: caseLabel }, { type: 'screenshot-written', case: caseLabel }, { type: 'case-finish', case: caseLabel });
    }
    schedule.push({ type: 'operation-finish', case: null });
    let previous = ZERO_SHA256;
    const perCase = new Map(expectedCaseLabels().map((label) => [label, { start: 0, finish: 0, inputs: 0, oracle: 0, screenshots: 0, actionSeq: 0, stages: [], lastMonotonic: -1 }]));
    const eventMap = new Map();
    const trusted = new Map(expectedCaseLabels().map((label) => [label, []]));
    const boundaries = new Map(expectedCaseLabels().map((label) => [label, {}]));
    events.forEach((event, index) => {
        exactKeys(event, ['seq', 'previousEventSha256', 'eventSha256', 'utc', 'monotonicMs', 'type', 'case', 'payload'], 'event');
        if (event.seq !== index + 1 || event.previousEventSha256 !== previous) fail('events.chain');
        if (event.type !== schedule[index].type || event.case !== schedule[index].case) fail('events.type');
        utc(event.utc, 'events.utc'); nonNegative(event.monotonicMs, 'events.monotonicMs'); string(event.type, 'events.type'); if (event.case !== null) string(event.case, 'events.case'); object(event.payload, 'events.payload');
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
            if (event.monotonicMs < count.lastMonotonic) fail('events.monotonicOrder'); count.lastMonotonic = event.monotonicMs;
            if (event.type === 'case-start') { exactKeys(event.payload, ['engine', 'originKind', 'requestedUrl'], 'events.caseStart.payload'); if (event.payload.engine !== event.case.split('-')[0] || event.payload.originKind !== event.case.split('-')[1]) fail('events.caseStart.payload'); string(event.payload.requestedUrl, 'events.caseStart.requestedUrl'); boundaries.get(event.case).start = event; count.start++; }
            else if (event.type === 'trusted-input') { exactKeys(event.payload, ['actionSeq', 'api', 'target', 'preStateSha256', 'postStateSha256', 'resultingUrl'], 'events.trustedInput.payload'); count.actionSeq++; if (event.payload.actionSeq !== count.actionSeq) fail('events.actionSequence'); string(event.payload.api, 'events.trustedInput.api'); string(event.payload.target, 'events.trustedInput.target'); sha(event.payload.preStateSha256, 'events.trustedInput.preStateSha256'); sha(event.payload.postStateSha256, 'events.trustedInput.postStateSha256'); string(event.payload.resultingUrl, 'events.trustedInput.resultingUrl'); trusted.get(event.case).push(event); count.inputs++; }
            else if (event.type === 'screenshot-oracle') { exactKeys(event.payload, ['stage', 'oracleSha256'], 'events.screenshotOracle.payload'); if (!STAGES.includes(event.payload.stage)) fail('events.screenshotOracle.stage'); sha(event.payload.oracleSha256, 'events.screenshotOracle.oracleSha256'); count.stages.push(`oracle:${event.payload.stage}`); eventMap.set(`${event.case}\0oracle\0${event.payload.stage}`, event); count.oracle++; }
            else if (event.type === 'screenshot-written') { exactKeys(event.payload, ['stage', 'path', 'pngSha256', 'oracleSha256'], 'events.screenshotWritten.payload'); if (!STAGES.includes(event.payload.stage)) fail('events.screenshotWritten.stage'); relativeFile(event.payload.path, 'events.screenshotWritten.path'); sha(event.payload.pngSha256, 'events.screenshotWritten.pngSha256'); sha(event.payload.oracleSha256, 'events.screenshotWritten.oracleSha256'); count.stages.push(`written:${event.payload.stage}`); eventMap.set(`${event.case}\0written\0${event.payload.stage}`, event); count.screenshots++; }
            else if (event.type === 'case-finish') { exactKeys(event.payload, ['actionCount', 'finalUrl'], 'events.caseFinish.payload'); if (event.payload.actionCount !== 38) fail('events.caseFinish.payload'); string(event.payload.finalUrl, 'events.caseFinish.finalUrl'); boundaries.get(event.case).finish = event; count.finish++; }
            else fail('events.type');
        }
        previous = event.eventSha256;
    });
    const expectedStages = ['oracle:initial', 'written:initial', 'oracle:progress', 'written:progress', 'oracle:ending', 'written:ending'];
    for (const count of perCase.values()) if (count.start !== 1 || count.finish !== 1 || count.inputs !== 38 || count.oracle !== 3 || count.screenshots !== 3 || canonicalJson(count.stages) !== canonicalJson(expectedStages)) fail('events.schedule');
    return { finalEventSha256: previous, eventMap, trusted, boundaries };
}

function relativeAcceptedPath(root, relative, invariant) {
    const normalized = relativeFile(relative, invariant);
    const absolute = contained(root, path.join(root, ...normalized.split('/')), invariant);
    noSymlinkAncestors(absolute, invariant);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(invariant, 'must be a regular file');
    return absolute;
}

function validateProductFiles(value, invariant) {
    exactKeys(value, PRODUCT_PATHS, invariant);
    for (const publicPath of PRODUCT_PATHS) {
        const record = value[publicPath];
        exactKeys(record, ['bytes', 'mime', 'sha256'], `${invariant}.${publicPath}`);
        nonNegative(record.bytes, `${invariant}.${publicPath}.bytes`); string(record.mime, `${invariant}.${publicPath}.mime`); sha(record.sha256, `${invariant}.${publicPath}.sha256`);
    }
}

function expectedProductsFromSource(sourceRoot) {
    const result = {};
    const mime = { '/': 'text/html', '/content.js': 'application/javascript', '/game-core.js': 'application/javascript', '/script.js': 'application/javascript', '/style.css': 'text/css' };
    for (const publicPath of PRODUCT_PATHS) {
        const relative = publicPath === '/' ? 'index.html' : publicPath.slice(1);
        const absolute = contained(sourceRoot, path.join(sourceRoot, relative), `campaign.source.${relative}`);
        noSymlinkAncestors(absolute, `campaign.source.${relative}`);
        const stat = fs.lstatSync(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) fail(`campaign.source.${relative}`);
        result[publicPath] = { bytes: stat.size, mime: mime[publicPath], sha256: sha256File(absolute) };
    }
    return result;
}

function authenticateCampaign(config) {
    const claimsPath = contained(config.campaignDir, path.join(config.campaignDir, 'claims.json'), 'campaign.claims.path');
    const envelopePath = contained(config.campaignDir, path.join(config.campaignDir, 'submission-envelope.json'), 'campaign.envelope.path');
    const candidatePath = contained(config.campaignDir, path.join(config.campaignDir, 'candidate-inventory.json'), 'campaign.candidate.path');
    const claims = validateCampaignClaims(readJson(claimsPath, 'campaign.claims.json'));
    const envelope = validateCampaignEnvelope(readJson(envelopePath, 'campaign.envelope.json'));
    const receipt = validateCampaignReceipt(readJson(config.campaignReceiptPath, 'campaign.receipt.json'));
    if (claims.runId !== config.campaignRunId || envelope.runId !== config.campaignRunId || receipt.runId !== config.campaignRunId) fail('campaign.runId');
    if (receipt.campaign.path !== canonicalPath(config.campaignDir, 'campaign.path') || receipt.spec.path !== canonicalPath(config.campaignSpecPath, 'campaign.spec.path')) fail('campaign.receipt.paths');
    if (!sameHash(receipt.campaign.artifactManifestSha256, sha256File(path.join(config.campaignDir, 'artifact-manifest.json'))) || !sameHash(receipt.campaign.submissionEnvelopeSha256, sha256File(envelopePath))) fail('campaign.receipt.hashes');
    if (receipt.spec.sizeBytes !== fs.statSync(config.campaignSpecPath).size || !sameHash(receipt.spec.sha256, sha256File(config.campaignSpecPath)) || envelope.spec.fileName !== path.basename(config.campaignSpecPath) || envelope.spec.sizeBytes !== receipt.spec.sizeBytes || !sameHash(envelope.spec.sha256, receipt.spec.sha256)) fail('campaign.spec.binding');
    for (const [name, expectedHash] of Object.entries(envelope.payloadHashes)) if (!sameHash(sha256File(path.join(config.campaignDir, name)), expectedHash)) fail(`campaign.envelope.payloadHashes.${name}`);
    for (const value of Object.values(envelope.rawEvidence)) if (!sameHash(sha256File(path.join(config.campaignDir, value.path)), value.sha256)) fail('campaign.rawEvidence');
    const candidate = readJson(candidatePath, 'campaign.candidate.json');
    exactKeys(candidate, ['schemaVersion', 'algorithm', 'pathEncoding', 'fileCount', 'pathListSha256', 'contentRecordsSha256', 'files'], 'campaign.candidateInventory');
    if (candidate.schemaVersion !== 1 || candidate.algorithm !== 'SHA-256' || candidate.pathEncoding !== 'UTF-8 NUL-terminated ordered path records' || !Array.isArray(candidate.files) || candidate.files.length !== candidate.fileCount) fail('campaign.candidateInventory');
    candidate.files.forEach((entry, index) => {
        exactKeys(entry, ['path', 'sizeBytes', 'sha256'], 'campaign.candidateInventory.file'); relativeFile(entry.path, 'campaign.candidateInventory.file.path'); nonNegative(entry.sizeBytes, 'campaign.candidateInventory.file.sizeBytes'); externalSha(entry.sha256, 'campaign.candidateInventory.file.sha256');
        if (index > 0 && candidate.files[index - 1].path.localeCompare(entry.path, 'en') >= 0) fail('campaign.candidateInventory.order');
        const source = contained(config.sourceSnapshotDir, path.join(config.sourceSnapshotDir, ...entry.path.split('/')), 'campaign.candidateInventory.file.path'); noSymlinkAncestors(source, 'campaign.candidateInventory.file.symlink'); const stat = fs.lstatSync(source);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.sizeBytes || !sameHash(sha256File(source), entry.sha256)) fail('campaign.sourceSnapshot.file');
    });
    if (canonicalJson(walkFiles(config.sourceSnapshotDir)) !== canonicalJson(candidate.files.map((entry) => entry.path))) fail('campaign.sourceSnapshot.fileSet');
    const measured = {
        fileCount: candidate.files.length,
        pathListSha256: sha256Bytes(Buffer.from(candidate.files.map((entry) => `${entry.path}\0`).join(''), 'utf8')),
        contentRecordsSha256: sha256Bytes(Buffer.from(candidate.files.map((entry) => `${entry.path}\0${entry.sizeBytes}\0${entry.sha256}\0`).join(''), 'utf8')),
    };
    const authority = { fileCount: candidate.fileCount, pathListSha256: candidate.pathListSha256, contentRecordsSha256: candidate.contentRecordsSha256 };
    if (measured.fileCount !== authority.fileCount || !sameHash(measured.pathListSha256, authority.pathListSha256) || !sameHash(measured.contentRecordsSha256, authority.contentRecordsSha256)) fail('campaign.sourceSnapshot.inventory');
    for (const binding of [claims.candidateInventory, { fileCount: envelope.source.fileCount, pathListSha256: envelope.source.pathListSha256, contentRecordsSha256: envelope.source.contentRecordsSha256 }, receipt.candidateInventory]) if (binding.fileCount !== authority.fileCount || !sameHash(binding.pathListSha256, authority.pathListSha256) || !sameHash(binding.contentRecordsSha256, authority.contentRecordsSha256)) fail('campaign.sourceSnapshot.inventory');
    if (envelope.source.path !== path.relative(config.campaignDir, config.sourceSnapshotDir).split(path.sep).join('/') || envelope.source.gitBranch !== claims.sourceGit.branch || envelope.source.gitHeadSha !== claims.sourceGit.headSha || canonicalJson(receipt.sourceGit) !== canonicalJson(claims.sourceGit)) fail('campaign.sourceGit');
    if (claims.sourceGit.branch !== 'main' || receipt.projectRoot !== canonicalPath(config.authorityProjectRoot, 'campaign.projectRoot') || receipt.cleanRoot !== canonicalPath(config.executionSourceDir, 'campaign.cleanRoot')) fail('campaign.authorityRoots');
    if (!sameHash(receipt.gameCoreSha256, claims.gameCoreSha256) || !sameHash(sha256File(path.join(config.sourceSnapshotDir, 'game-core.js')), claims.gameCoreSha256)) fail('campaign.gameCoreSha256');
    if (canonicalJson(receipt.r9Frozen) !== canonicalJson(claims.r9Frozen) || canonicalJson(receipt.r10Frozen) !== canonicalJson(claims.r10Frozen) || canonicalJson(receipt.limitation) !== canonicalJson(claims.actualBrowserZoom)) fail('campaign.receipt.claimsBinding');
    for (const command of receipt.commands) {
        if (command.cwd !== canonicalPath(config.executionSourceDir, 'campaign.command.cwd')) fail('campaign.receipt.command.cwd');
        const stdout = relativeAcceptedPath(config.campaignDir, command.stdoutPath, 'campaign.receipt.command.stdoutPath');
        const stderr = relativeAcceptedPath(config.campaignDir, command.stderrPath, 'campaign.receipt.command.stderrPath');
        if (!sameHash(sha256File(stdout), command.stdoutSha256) || !sameHash(sha256File(stderr), command.stderrSha256)) fail('campaign.receipt.command.stream');
    }
    return { claims, envelope, receipt, productFiles: expectedProductsFromSource(config.sourceSnapshotDir) };
}

function validateExternalCaptureFiles(capture, invariant) {
    noSymlinkAncestors(capture.stdoutPath, `${invariant}.stdout.symlink`); noSymlinkAncestors(capture.stderrPath, `${invariant}.stderr.symlink`);
    const stdout = fs.readFileSync(capture.stdoutPath); const stderr = fs.readFileSync(capture.stderrPath);
    if (stdout.length !== capture.stdoutBytes || sha256Bytes(stdout) !== capture.stdoutSha256) fail(`${invariant}.stdout`);
    if (stderr.length !== capture.stderrBytes || sha256Bytes(stderr) !== capture.stderrSha256) fail(`${invariant}.stderr`);
    return { stdout, stderr };
}

function loadCommittedOperationAuthority(config) {
    validateOperationConfig(config);
    const campaign = authenticateCampaign(config);
    const recordBytes = fs.readFileSync(config.deploymentRecordPath);
    let deployment;
    try { deployment = validateDeploymentRecord(JSON.parse(recordBytes.toString('utf8'))); } catch (error) { fail('deploymentRecord.json', error.message); }
    if (deployment.projectName !== config.projectName || deployment.immutableUrl !== config.immutableUrl || deployment.aliasUrl !== config.aliasUrl) fail('deploymentRecord.configBinding');
    if (deployment.sourceGitHead !== campaign.claims.sourceGit.headSha) fail('campaign.deployment.sourceGitHead');
    if (canonicalJson(deployment.productFiles) !== canonicalJson(campaign.productFiles)) fail('campaign.deployment.productFiles');
    const deploymentOperatorReceipt = validateDeploymentOperatorReceipt(config, deployment, recordBytes);
    return { campaign, deployment, deploymentOperatorReceipt, productFiles: campaign.productFiles, sourceGitHead: campaign.claims.sourceGit.headSha };
}

export function loadOperationAuthority(config) {
    const authority = loadCommittedOperationAuthority(config);
    return { deployment: authority.deployment, productFiles: authority.productFiles, sourceGitHead: authority.sourceGitHead };
}

function authenticateProcessCaptures(config, operation, configPath) {
    if (operation.configPath !== canonicalPath(configPath, 'operationReceipt.configPath')) fail('operationReceipt.configPath');
    const verifierPath = path.join(config.sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs');
    const orchestratorSnapshotPath = path.join(config.sourceSnapshotDir, 'scripts', 'run-public-smoke-v2-operation.mjs');
    const runnerPath = path.join(config.sourceSnapshotDir, 'scripts', 'run-public-smoke-v2.mjs');
    validateExecutedSnapshotBinding(operation.orchestratorPath, orchestratorSnapshotPath);
    if (operation.orchestratorSha256 !== sha256File(operation.orchestratorPath) || operation.campaignVerifier.verifierPath !== verifierPath || operation.campaignVerifier.verifierSha256 !== sha256File(verifierPath)) fail('operationReceipt.scriptBinding');
    const verifierArgv = [config.nodeExePath, verifierPath, '--campaign', config.campaignDir, '--spec', config.campaignSpecPath, '--source', config.sourceSnapshotDir, '--execution-source', config.executionSourceDir, '--run', config.campaignRunId, '--authority-project', config.authorityProjectRoot, '--authority-workspace', config.authorityWorkspaceRoot];
    const workerArgv = [config.nodeExePath, runnerPath, '--config', configPath];
    if (canonicalJson(operation.campaignVerifier.argv) !== canonicalJson(verifierArgv) || operation.campaignVerifier.cwd !== canonicalPath(config.authorityProjectRoot, 'campaignVerifier.cwd')) fail('operationReceipt.campaignVerifier.argv');
    if (canonicalJson(operation.worker.argv) !== canonicalJson(workerArgv) || operation.worker.cwd !== canonicalPath(config.authorityProjectRoot, 'worker.cwd')) fail('operationReceipt.worker.argv');
    contained(config.releaseRoot, operation.campaignVerifier.stdoutPath, 'campaignVerifier.stdoutPath'); contained(config.releaseRoot, operation.campaignVerifier.stderrPath, 'campaignVerifier.stderrPath');
    if (operation.worker.stdoutPath !== canonicalPath(config.workerStdoutPath, 'worker.stdoutPath') || operation.worker.stderrPath !== canonicalPath(config.workerStderrPath, 'worker.stderrPath')) fail('worker.streamPath');
    const verifier = validateExternalCaptureFiles(operation.campaignVerifier, 'campaignVerifier');
    const worker = validateExternalCaptureFiles(operation.worker, 'worker');
    if (operation.campaignVerifier.exitCode !== 0 || operation.campaignVerifier.signal !== null || verifier.stderr.length !== 0 || verifier.stdout.toString('utf8') !== 'R10_CAMPAIGN_GATE=VERIFIED\n' || operation.campaignVerifier.gateLine !== 'R10_CAMPAIGN_GATE=VERIFIED') fail('campaignVerifier.gateLine');
    if (operation.worker.exitCode !== 0 || operation.worker.signal !== null || worker.stderr.length !== 0) fail('worker.stderr');
}

function validateWranglerCapture(root, relative, phase, config, deployment) {
    const captureFile = relativeAcceptedPath(root, relative, `cloudflare.${phase}.capturePath`);
    const capture = readJson(captureFile, `cloudflare.${phase}.capture`);
    exactKeys(capture, ['schemaVersion', 'phase', 'argv', 'cwd', 'startedUtc', 'finishedUtc', 'exitCode', 'nodeSha256', 'wranglerSha256', 'stdoutPath', 'stdoutBytes', 'stdoutSha256', 'stderrPath', 'stderrBytes', 'stderrSha256'], `cloudflare.${phase}.capture`);
    if (capture.schemaVersion !== 1 || capture.phase !== phase) fail(`cloudflare.${phase}.capture`);
    const argv = [config.nodeExePath, config.wranglerJsPath, 'pages', 'deployment', 'list', '--project-name', config.projectName, '--environment', 'production', '--json'];
    if (canonicalJson(capture.argv) !== canonicalJson(argv) || capture.cwd !== canonicalPath(config.authorityProjectRoot, `cloudflare.${phase}.cwd`) || capture.nodeSha256 !== config.nodeExeSha256 || capture.wranglerSha256 !== config.wranglerJsSha256) fail(`cloudflare.${phase}.command`);
    utc(capture.startedUtc, `cloudflare.${phase}.startedUtc`); utc(capture.finishedUtc, `cloudflare.${phase}.finishedUtc`); if (Date.parse(capture.finishedUtc) < Date.parse(capture.startedUtc)) fail(`cloudflare.${phase}.time`); integer(capture.exitCode, `cloudflare.${phase}.exitCode`);
    if (capture.stdoutPath !== `control-plane/${phase}.stdout.bin` || capture.stderrPath !== `control-plane/${phase}.stderr.bin`) fail(`cloudflare.${phase}.streamPath`);
    const stdoutFile = relativeAcceptedPath(root, capture.stdoutPath, `cloudflare.${phase}.stdoutPath`); const stderrFile = relativeAcceptedPath(root, capture.stderrPath, `cloudflare.${phase}.stderrPath`);
    const stdout = fs.readFileSync(stdoutFile); const stderr = fs.readFileSync(stderrFile);
    nonNegative(capture.stdoutBytes, `cloudflare.${phase}.stdoutBytes`); sha(capture.stdoutSha256, `cloudflare.${phase}.stdoutSha256`); nonNegative(capture.stderrBytes, `cloudflare.${phase}.stderrBytes`); sha(capture.stderrSha256, `cloudflare.${phase}.stderrSha256`);
    if (stdout.length !== capture.stdoutBytes || sha256Bytes(stdout) !== capture.stdoutSha256 || stderr.length !== capture.stderrBytes || sha256Bytes(stderr) !== capture.stderrSha256 || capture.exitCode !== 0 || stderr.length !== 0) fail(`cloudflare.${phase}.streams`);
    let rows; try { rows = JSON.parse(stdout.toString('utf8')); } catch { fail(`cloudflare.${phase}.stdoutJson`); }
    if (!Array.isArray(rows) || rows.length < 1) fail(`cloudflare.${phase}.records`);
    rows.forEach((record) => {
        exactKeys(record, ['Id', 'Environment', 'Branch', 'Source', 'Deployment', 'Status', 'Build'], `cloudflare.${phase}.record`);
        for (const key of ['Id', 'Environment', 'Branch', 'Source', 'Deployment', 'Status', 'Build']) string(record[key], `cloudflare.${phase}.record.${key}`);
    });
    const first = rows[0];
    if (first.Id !== deployment.deploymentId || first.Environment !== 'Production' || first.Branch !== 'main' || first.Deployment !== deployment.immutableUrl || first.Source !== deployment.sourceGitHead.slice(0, 7)) fail(`cloudflare.${phase}DeploymentId`);
    return { capture, captureFile };
}

function validateProbe(root, relative, phase, expectedOrigins, campaign, deployment) {
    const invariantPhase = phase === 'final-alias' ? 'finalAlias' : phase;
    const file = relativeAcceptedPath(root, relative, `fileGate.${invariantPhase}.path`);
    const probe = readJson(file, `fileGate.${invariantPhase}.json`);
    exactKeys(probe, ['schemaVersion', 'phase', 'startedUtc', 'finishedUtc', 'expectedSourceGitHead', 'expectedDeploymentId', 'results', 'passed', 'total'], `fileGate.${invariantPhase}`);
    if (probe.schemaVersion !== 2 || probe.phase !== phase || probe.expectedSourceGitHead !== campaign.claims.sourceGit.headSha || probe.expectedDeploymentId !== deployment.deploymentId) fail(`fileGate.${invariantPhase}.binding`);
    utc(probe.startedUtc, `fileGate.${invariantPhase}.startedUtc`); utc(probe.finishedUtc, `fileGate.${invariantPhase}.finishedUtc`); if (Date.parse(probe.finishedUtc) < Date.parse(probe.startedUtc)) fail(`fileGate.${invariantPhase}.time`);
    const expected = expectedOrigins.flatMap((originKind) => PRODUCT_PATHS.map((publicPath) => [originKind, publicPath]));
    if (!Array.isArray(probe.results) || probe.results.length !== expected.length || probe.passed !== expected.length || probe.total !== expected.length) fail(`fileGate.${invariantPhase}.cardinality`);
    probe.results.forEach((result, index) => {
        exactKeys(result, ['originKind', 'path', 'requestedUrl', 'finalUrl', 'redirects', 'status', 'contentType', 'mime', 'bodyPath', 'bytes', 'sha256', 'startedUtc', 'finishedUtc', 'transportError'], `fileGate.${invariantPhase}.result`);
        const [originKind, publicPath] = expected[index];
        const baseUrl = originKind === 'immutable' ? deployment.immutableUrl : deployment.aliasUrl;
        const expectedUrl = new URL(publicPath === '/' ? '/' : publicPath.slice(1), baseUrl).href;
        if (result.originKind !== originKind || result.path !== publicPath || result.requestedUrl !== expectedUrl || result.finalUrl !== expectedUrl || result.status !== 200 || result.transportError !== null) fail(`fileGate.${invariantPhase}.identity`);
        if (!Array.isArray(result.redirects) || result.redirects.length !== 0) fail(`fileGate.${invariantPhase}.redirects`);
        const contentType = string(result.contentType, `fileGate.${invariantPhase}.contentType`);
        const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
        string(result.mime, `fileGate.${invariantPhase}.mime`);
        if (!mediaType || mediaType !== campaign.productFiles[publicPath].mime || result.mime !== campaign.productFiles[publicPath].mime) fail(`fileGate.${invariantPhase}.mime`);
        nonNegative(result.bytes, `fileGate.${invariantPhase}.bytes`); sha(result.sha256, `fileGate.${invariantPhase}.sha256`); utc(result.startedUtc, `fileGate.${invariantPhase}.startedUtc`); utc(result.finishedUtc, `fileGate.${invariantPhase}.finishedUtc`); if (Date.parse(result.finishedUtc) < Date.parse(result.startedUtc)) fail(`fileGate.${invariantPhase}.time`);
        const token = publicPath === '/' ? 'root' : publicPath.slice(1).replaceAll('.', '-');
        const expectedPrefix = phase === 'initial' ? `initial-${originKind}` : 'final-alias';
        if (result.bodyPath !== `file-probes/bodies/${expectedPrefix}-${token}.bin`) fail(`fileGate.${invariantPhase}.bodyPath`);
        const body = relativeAcceptedPath(root, result.bodyPath, `fileGate.${invariantPhase}.bodyPath`);
        if (fs.statSync(body).size !== result.bytes || sha256File(body) !== result.sha256 || result.bytes !== campaign.productFiles[publicPath].bytes || result.sha256 !== campaign.productFiles[publicPath].sha256) fail(`fileGate.${invariantPhase}.${publicPath === '/script.js' ? 'scriptSha256' : 'sourceBytes'}`);
    });
    return { probe, file };
}

function validateAcceptedRunSchema(accepted) {
    exactKeys(accepted, ['schemaVersion', 'releaseId', 'campaignRunId', 'sourceGitHead', 'deploymentId', 'immutableUrl', 'aliasUrl', 'startedUtc', 'finishedUtc', 'startedMonotonicMs', 'finishedMonotonicMs', 'engines', 'originKinds', 'attemptsPerCase', 'retries', 'skips', 'caseLabels', 'observationsPath', 'eventsPath', 'screenshotCount', 'productFiles', 'tooling'], 'acceptedRun');
    if (accepted.schemaVersion !== SMOKE_SCHEMA_VERSION || !RELEASE_ID.test(string(accepted.releaseId, 'acceptedRun.releaseId')) || !CAMPAIGN_ID.test(string(accepted.campaignRunId, 'acceptedRun.campaignRunId'))) fail('acceptedRun.identity');
    gitSha(accepted.sourceGitHead, 'acceptedRun.sourceGitHead'); string(accepted.deploymentId, 'acceptedRun.deploymentId'); validateUrl(accepted.immutableUrl, 'acceptedRun.immutableUrl'); validateUrl(accepted.aliasUrl, 'acceptedRun.aliasUrl'); utc(accepted.startedUtc, 'acceptedRun.startedUtc'); utc(accepted.finishedUtc, 'acceptedRun.finishedUtc'); nonNegative(accepted.startedMonotonicMs, 'acceptedRun.startedMonotonicMs'); nonNegative(accepted.finishedMonotonicMs, 'acceptedRun.finishedMonotonicMs');
    if (Date.parse(accepted.finishedUtc) < Date.parse(accepted.startedUtc) || accepted.finishedMonotonicMs < accepted.startedMonotonicMs || accepted.finishedMonotonicMs - accepted.startedMonotonicMs >= 900000) fail('acceptedRun.duration');
    for (const key of ['attemptsPerCase', 'retries', 'skips', 'screenshotCount']) integer(accepted[key], `acceptedRun.${key}`); relativeFile(accepted.observationsPath, 'acceptedRun.observationsPath'); relativeFile(accepted.eventsPath, 'acceptedRun.eventsPath');
    sameArray(accepted.engines, ENGINES, 'acceptedRun.engines'); sameArray(accepted.originKinds, ORIGINS, 'acceptedRun.originKinds'); sameArray(accepted.caseLabels, expectedCaseLabels(), 'acceptedRun.caseLabels');
    validateProductFiles(accepted.productFiles, 'acceptedRun.productFiles'); exactKeys(accepted.tooling, ['runner', 'library', 'playwright'], 'acceptedRun.tooling');
    for (const key of ['runner', 'library', 'playwright']) { exactKeys(accepted.tooling[key], ['path', 'version', 'sha256'], `acceptedRun.tooling.${key}`); relativeFile(accepted.tooling[key].path, `acceptedRun.tooling.${key}.path`); string(accepted.tooling[key].version, `acceptedRun.tooling.${key}.version`); sha(accepted.tooling[key].sha256, `acceptedRun.tooling.${key}.sha256`); }
}

function validateScreenshot(record, root, screenshot, index, eventMap) {
    validateScreenshotShape(record, screenshot, index);
    const stage = STAGES[index]; const expectedPath = `screenshots/${expectedScreenshotName(record.label, stage)}`; const expectedViewport = stage === 'ending' ? { width: 640, height: 360 } : { width: 320, height: 640 };
    if (screenshot.caseLabel !== record.label || screenshot.stage !== stage || screenshot.relativePath !== expectedPath) fail('screenshot.path');
    exactKeys(screenshot.viewport, ['width', 'height'], 'screenshot.viewport'); if (screenshot.viewport.width !== expectedViewport.width || screenshot.viewport.height !== expectedViewport.height) fail('screenshot.viewport');
    if (screenshot.requestedOrigin !== new URL(record.requestedUrl).origin || screenshot.finalUrl !== record.finalUrl) fail('screenshot.origin');
    sha(screenshot.oracleSnapshotSha256, 'screenshot.oracleSnapshotSha256'); utc(screenshot.captureStartedUtc, 'screenshot.captureStartedUtc'); utc(screenshot.captureFinishedUtc, 'screenshot.captureFinishedUtc'); if (Date.parse(screenshot.captureFinishedUtc) <= Date.parse(screenshot.captureStartedUtc)) fail('screenshot.timestamps');
    nonNegative(screenshot.bytes, 'screenshot.bytes'); sha(screenshot.sha256, 'screenshot.sha256'); const file = relativeAcceptedPath(root, screenshot.relativePath, 'screenshot.path');
    if (fs.statSync(file).size !== screenshot.bytes || sha256File(file) !== screenshot.sha256) fail('screenshot.hash'); validatePngEvidence(file, screenshot.viewport, 'png');
    const oracle = eventMap.get(`${record.label}\0oracle\0${stage}`); const written = eventMap.get(`${record.label}\0written\0${stage}`);
    if (!oracle || oracle.payload.oracleSha256 !== screenshot.oracleSnapshotSha256 || oracle.utc !== screenshot.captureStartedUtc) fail('screenshot.oracleBinding');
    if (!written || written.payload.path !== screenshot.relativePath || written.payload.pngSha256 !== screenshot.sha256 || written.payload.oracleSha256 !== screenshot.oracleSnapshotSha256 || written.utc !== screenshot.captureFinishedUtc) fail('screenshot.eventBinding');
}

export function validateAuditReceipt(receipt, expected) {
    const keys = ['schemaVersion', 'releaseId', 'status', 'createdUtc', 'auditedTargetRealpath', 'configSha256', 'operationReceiptSha256', 'acceptedManifestSha256', 'eventsSha256', 'finalEventSha256', 'deploymentId', 'passedCases', 'totalCases', 'controlPlaneReads', 'initialFileGate', 'finalAliasGate', 'screenshotBindings'];
    exactKeys(receipt, keys, 'auditReceipt');
    if (receipt.schemaVersion !== 1 || receipt.status !== 'VERIFIED' || receipt.passedCases !== 6 || receipt.totalCases !== 6 || receipt.controlPlaneReads !== 3) fail('auditReceipt.summary');
    if (!RELEASE_ID.test(string(receipt.releaseId, 'auditReceipt.releaseId'))) fail('auditReceipt.releaseId'); utc(receipt.createdUtc, 'auditReceipt.createdUtc'); canonicalPath(receipt.auditedTargetRealpath, 'auditReceipt.auditedTargetRealpath'); string(receipt.deploymentId, 'auditReceipt.deploymentId');
    exactKeys(receipt.initialFileGate, ['passed', 'total'], 'auditReceipt.initialFileGate'); exactKeys(receipt.finalAliasGate, ['passed', 'total'], 'auditReceipt.finalAliasGate');
    if (receipt.initialFileGate.passed !== 10 || receipt.initialFileGate.total !== 10 || receipt.finalAliasGate.passed !== 5 || receipt.finalAliasGate.total !== 5) fail('auditReceipt.gates');
    for (const key of ['configSha256', 'operationReceiptSha256', 'acceptedManifestSha256', 'eventsSha256', 'finalEventSha256']) sha(receipt[key], `auditReceipt.${key}`);
    if (!Array.isArray(receipt.screenshotBindings) || receipt.screenshotBindings.length !== 18) fail('auditReceipt.screenshotBindings');
    receipt.screenshotBindings.forEach((binding) => {
        exactKeys(binding, ['case', 'stage', 'path', 'pngSha256', 'oracleSha256', 'captureStartUtc', 'captureEndUtc'], 'auditReceipt.screenshotBinding');
        if (!expectedCaseLabels().includes(binding.case) || !STAGES.includes(binding.stage)) fail('auditReceipt.screenshotBinding.tuple'); relativeFile(binding.path, 'auditReceipt.screenshotBinding.path'); sha(binding.pngSha256, 'auditReceipt.screenshotBinding.pngSha256'); sha(binding.oracleSha256, 'auditReceipt.screenshotBinding.oracleSha256'); utc(binding.captureStartUtc, 'auditReceipt.screenshotBinding.captureStartUtc'); utc(binding.captureEndUtc, 'auditReceipt.screenshotBinding.captureEndUtc'); if (Date.parse(binding.captureEndUtc) <= Date.parse(binding.captureStartUtc)) fail('auditReceipt.screenshotBinding.timestamps');
    });
    const expectedTuples = expectedCaseLabels().flatMap((caseLabel) => STAGES.map((stage) => `${caseLabel}\0${stage}\0screenshots/${expectedScreenshotName(caseLabel, stage)}`));
    const actualTuples = receipt.screenshotBindings.map((binding) => `${binding.case}\0${binding.stage}\0${binding.path}`);
    sameArray(actualTuples, expectedTuples, 'auditReceipt.screenshotBindings');
    if (expected !== undefined && canonicalJson({ ...receipt, createdUtc: expected.createdUtc }) !== canonicalJson(expected)) fail('auditReceipt.binding');
    return receipt;
}

export function validateNegativeReceipt(receipt, expected = {}) {
    const keys = ['schemaVersion', 'releaseId', 'status', 'createdUtc', 'configSha256', 'operationReceiptSha256', 'pristineManifestSha256', 'pristineTreeDigest', 'initialPristineAuditReceiptSha256', 'finalPristineAuditReceiptSha256', 'checkpoints', 'controls'];
    exactKeys(receipt, keys, 'negativeReceipt');
    if (receipt.schemaVersion !== 1 || receipt.status !== 'VERIFIED') fail('negativeReceipt.status');
    if (!RELEASE_ID.test(string(receipt.releaseId, 'negativeReceipt.releaseId'))) fail('negativeReceipt.releaseId');
    utc(receipt.createdUtc, 'negativeReceipt.createdUtc');
    for (const key of ['configSha256', 'operationReceiptSha256', 'pristineManifestSha256', 'pristineTreeDigest', 'initialPristineAuditReceiptSha256', 'finalPristineAuditReceiptSha256']) sha(receipt[key], `negativeReceipt.${key}`);

    if (!Array.isArray(receipt.checkpoints) || receipt.checkpoints.length !== 25) fail('negativeReceipt.checkpoints.cardinality');
    const expectedCheckpoints = [{ controlId: 'BASELINE', phase: 'BASELINE' }];
    for (const { id } of NEGATIVE_CONTROL_REGISTRY) expectedCheckpoints.push({ controlId: id, phase: 'BEFORE' }, { controlId: id, phase: 'AFTER' });
    receipt.checkpoints.forEach((checkpoint, index) => {
        exactKeys(checkpoint, ['sequence', 'controlId', 'phase', 'treeDigest', 'auditReceiptSha256', 'auditStatus'], 'negativeReceipt.checkpoint');
        if (checkpoint.sequence !== index + 1 || checkpoint.controlId !== expectedCheckpoints[index].controlId || checkpoint.phase !== expectedCheckpoints[index].phase) fail('negativeReceipt.checkpoints.order');
        if (checkpoint.treeDigest !== receipt.pristineTreeDigest) fail('negativeReceipt.checkpoint.treeDigest');
        sha(checkpoint.auditReceiptSha256, 'negativeReceipt.checkpoint.auditReceiptSha256');
        if (checkpoint.auditStatus !== 'VERIFIED') fail('negativeReceipt.checkpoint.auditStatus');
    });
    if (new Set(receipt.checkpoints.map(({ auditReceiptSha256 }) => auditReceiptSha256)).size !== 25 || receipt.initialPristineAuditReceiptSha256 === receipt.finalPristineAuditReceiptSha256) fail('negativeReceipt.checkpoints.unique');
    if (receipt.checkpoints[0].auditReceiptSha256 !== receipt.initialPristineAuditReceiptSha256 || receipt.checkpoints.at(-1).auditReceiptSha256 !== receipt.finalPristineAuditReceiptSha256) fail('negativeReceipt.checkpoints.auditBinding');

    if (!Array.isArray(receipt.controls) || receipt.controls.length !== NEGATIVE_CONTROL_REGISTRY.length) fail('negativeReceipt.controls.cardinality');
    const mutationRoots = [], targets = [], derivedConfigPaths = [];
    receipt.controls.forEach((control, index) => {
        exactKeys(control, ['id', 'expectedInvariant', 'derivedConfigSha256', 'mutationRootRealpath', 'targetRealpath', 'auditorArgv', 'exitCode', 'signal', 'stdoutSha256', 'stderrSha256', 'emittedTargetRealpath', 'successGateAbsent', 'observedInvariant'], 'negativeReceipt.control');
        const registry = NEGATIVE_CONTROL_REGISTRY[index];
        if (control.id !== registry.id || control.expectedInvariant !== registry.expectedInvariant) fail('negativeReceipt.controls.order');
        sha(control.derivedConfigSha256, 'negativeReceipt.control.derivedConfigSha256');
        const mutationRoot = canonicalPath(control.mutationRootRealpath, 'negativeReceipt.control.mutationRootRealpath');
        const target = canonicalPath(control.targetRealpath, 'negativeReceipt.control.targetRealpath');
        if (fs.realpathSync(mutationRoot) !== mutationRoot || fs.realpathSync(target) !== target || target !== path.join(mutationRoot, 'accepted') || control.emittedTargetRealpath !== target || (expected.pristineAcceptedRealpath && target === fs.realpathSync(expected.pristineAcceptedRealpath))) fail('negativeReceipt.control.targetRealpath');
        if (!Array.isArray(control.auditorArgv) || control.auditorArgv.length !== 4 || control.auditorArgv.some((item) => typeof item !== 'string')) fail('negativeReceipt.control.auditorArgv');
        const expectedConfigPath = path.join(mutationRoot, 'audit-config.json');
        if (!path.isAbsolute(control.auditorArgv[0]) || !path.isAbsolute(control.auditorArgv[1]) || control.auditorArgv[2] !== '--config' || control.auditorArgv[3] !== expectedConfigPath) fail('negativeReceipt.control.auditorArgv');
        mutationRoots.push(mutationRoot); targets.push(target); derivedConfigPaths.push(control.auditorArgv[3]);
        if (expected.nodeExePath && control.auditorArgv[0] !== expected.nodeExePath) fail('negativeReceipt.control.auditorArgv');
        if (expected.auditorPath && control.auditorArgv[1] !== expected.auditorPath) fail('negativeReceipt.control.auditorArgv');
        if (integer(control.exitCode, 'negativeReceipt.control.exitCode') === 0) fail('negativeReceipt.control.exitCode');
        if (control.signal !== null) fail('negativeReceipt.control.signal');
        sha(control.stdoutSha256, 'negativeReceipt.control.stdoutSha256'); sha(control.stderrSha256, 'negativeReceipt.control.stderrSha256');
        if (control.successGateAbsent !== true) fail('negativeReceipt.control.successGateAbsent');
        if (control.observedInvariant !== registry.expectedInvariant) fail('negativeReceipt.control.observedInvariant');
    });
    for (const [label, values] of [['mutationRootRealpath', mutationRoots], ['targetRealpath', targets], ['derivedConfigPath', derivedConfigPaths]]) {
        if (new Set(values).size !== NEGATIVE_CONTROL_REGISTRY.length) fail(`negativeReceipt.controls.unique.${label}`);
    }

    if (expected.checkpointAuditReceipts !== undefined) {
        if (!Array.isArray(expected.checkpointAuditReceipts) || expected.checkpointAuditReceipts.length !== 25) fail('negativeReceipt.checkpointAuditReceipts');
        const auditHashes = expected.checkpointAuditReceipts.map((audit) => {
            validateAuditReceipt(audit);
            return sha256Bytes(Buffer.from(`${JSON.stringify(audit)}\n`));
        });
        if (new Set(auditHashes).size !== 25) fail('negativeReceipt.checkpointAuditReceipts.unique');
        expected.checkpointAuditReceipts.forEach((audit, index) => {
            const auditSha = auditHashes[index];
            if (auditSha !== receipt.checkpoints[index].auditReceiptSha256 || audit.status !== receipt.checkpoints[index].auditStatus) fail('negativeReceipt.checkpoint.auditReceipt');
            if (expected.pristineAcceptedRealpath && audit.auditedTargetRealpath !== fs.realpathSync(expected.pristineAcceptedRealpath)) fail('negativeReceipt.checkpoint.auditTarget');
        });
    }
    return receipt;
}

const CLOSURE_BODY_TOKENS = Object.freeze(['root', 'content-js', 'game-core-js', 'script-js', 'style-css']);

export function validateClosureReceipt(receipt, expected = {}) {
    exactKeys(receipt, ['schemaVersion', 'releaseId', 'createdUtc', 'configSha256', 'operationReceiptSha256', 'auditReceiptSha256', 'negativeReceiptSha256', 'acceptedManifestSha256', 'ownershipRead', 'finalAliasProbe', 'status'], 'closureReceipt');
    if (receipt.schemaVersion !== 1 || receipt.status !== 'VERIFIED') fail('closureReceipt.status');
    if (!RELEASE_ID.test(string(receipt.releaseId, 'closureReceipt.releaseId'))) fail('closureReceipt.releaseId');
    utc(receipt.createdUtc, 'closureReceipt.createdUtc');
    for (const key of ['configSha256', 'operationReceiptSha256', 'auditReceiptSha256', 'negativeReceiptSha256', 'acceptedManifestSha256']) sha(receipt[key], `closureReceipt.${key}`);

    const ownership = receipt.ownershipRead;
    exactKeys(ownership, ['argv', 'cwd', 'startedUtc', 'finishedUtc', 'exitCode', 'signal', 'stdoutPath', 'stdoutBytes', 'stdoutSha256', 'stderrPath', 'stderrBytes', 'stderrSha256', 'deploymentId', 'sourcePrefix', 'immutableUrl'], 'closureReceipt.ownershipRead');
    if (!Array.isArray(ownership.argv) || ownership.argv.length !== 10 || ownership.argv.some((value) => typeof value !== 'string')) fail('closureReceipt.ownershipRead.argv');
    canonicalPath(ownership.cwd, 'closureReceipt.ownershipRead.cwd');
    utc(ownership.startedUtc, 'closureReceipt.ownershipRead.startedUtc');
    utc(ownership.finishedUtc, 'closureReceipt.ownershipRead.finishedUtc');
    if (Date.parse(ownership.finishedUtc) < Date.parse(ownership.startedUtc)) fail('closureReceipt.ownershipRead.time');
    if (integer(ownership.exitCode, 'closureReceipt.ownershipRead.exitCode') !== 0) fail('closureReceipt.ownershipRead.exitCode');
    if (ownership.signal !== null) fail('closureReceipt.ownershipRead.signal');
    relativeFile(ownership.stdoutPath, 'closureReceipt.ownershipRead.stdoutPath');
    relativeFile(ownership.stderrPath, 'closureReceipt.ownershipRead.stderrPath');
    nonNegative(ownership.stdoutBytes, 'closureReceipt.ownershipRead.stdoutBytes');
    nonNegative(ownership.stderrBytes, 'closureReceipt.ownershipRead.stderrBytes');
    sha(ownership.stdoutSha256, 'closureReceipt.ownershipRead.stdoutSha256');
    sha(ownership.stderrSha256, 'closureReceipt.ownershipRead.stderrSha256');
    string(ownership.deploymentId, 'closureReceipt.ownershipRead.deploymentId');
    if (!/^[a-f0-9]{7}$/.test(string(ownership.sourcePrefix, 'closureReceipt.ownershipRead.sourcePrefix'))) fail('closureReceipt.ownershipRead.sourcePrefix');
    validateUrl(ownership.immutableUrl, 'closureReceipt.ownershipRead.immutableUrl');

    const probe = receipt.finalAliasProbe;
    exactKeys(probe, ['receiptPath', 'receiptSha256', 'bodyPaths', 'bodySha256s', 'passed', 'total'], 'closureReceipt.finalAliasProbe');
    if (probe.receiptPath !== 'file-probes/closure-final-alias-5.json') fail('closureReceipt.finalAliasProbe.receiptPath');
    relativeFile(probe.receiptPath, 'closureReceipt.finalAliasProbe.receiptPath');
    sha(probe.receiptSha256, 'closureReceipt.finalAliasProbe.receiptSha256');
    if (!Array.isArray(probe.bodyPaths) || !Array.isArray(probe.bodySha256s) || probe.bodyPaths.length !== 5 || probe.bodySha256s.length !== 5) fail('closureReceipt.finalAliasProbe.bodyBindings');
    probe.bodyPaths.forEach((bodyPath, index) => {
        if (bodyPath !== `file-probes/bodies/closure-alias-${CLOSURE_BODY_TOKENS[index]}.bin`) fail('closureReceipt.finalAliasProbe.bodyPaths');
        relativeFile(bodyPath, 'closureReceipt.finalAliasProbe.bodyPath');
        sha(probe.bodySha256s[index], 'closureReceipt.finalAliasProbe.bodySha256');
    });
    if (probe.passed !== 5 || probe.total !== 5) fail('closureReceipt.finalAliasProbe.gate');

    for (const [key, actual] of [
        ['releaseId', receipt.releaseId],
        ['configSha256', receipt.configSha256],
        ['operationReceiptSha256', receipt.operationReceiptSha256],
        ['auditReceiptSha256', receipt.auditReceiptSha256],
        ['negativeReceiptSha256', receipt.negativeReceiptSha256],
        ['acceptedManifestSha256', receipt.acceptedManifestSha256],
        ['deploymentId', ownership.deploymentId],
        ['sourcePrefix', ownership.sourcePrefix],
        ['immutableUrl', ownership.immutableUrl],
        ['cwd', ownership.cwd],
    ]) if (expected[key] !== undefined && actual !== expected[key]) fail(`closureReceipt.${key}.binding`);
    if (expected.argv !== undefined && canonicalJson(ownership.argv) !== canonicalJson(expected.argv)) fail('closureReceipt.ownershipRead.argv.binding');
    return receipt;
}

const ACTUAL_CHROME_VISIBLE_KEYS = ['chromeZoomMenu', 'heading', 'signatureRoast', 'quoteCounter', 'npc', 'ending'];
const FINAL_RECEIPT_KEYS = ['schemaVersion', 'releaseId', 'status', 'createdUtc', 'finalizerPath', 'finalizerSha256', 'configSha256', 'campaignVerifierProofSha256', 'operationReceiptSha256', 'auditReceiptSha256', 'negativeReceiptSha256', 'closureReceiptSha256', 'actualChromeEvidencePath', 'actualChromeEvidenceSha256', 'acceptedManifestSha256', 'eventsSha256', 'finalEventSha256', 'deploymentId', 'immutableUrl', 'aliasUrl', 'fileGates', 'smokeGate', 'negativeGate', 'screenshotBindings', 'actualChrome', 'productFiles'];

export function validateActualChromeEvidence(value, expected = {}) {
    exactKeys(value, ['schemaVersion', 'releaseId', 'createdUtc', 'captureAuthority', 'browser', 'deployment', 'zoom200', 'restore100'], 'actualChrome');
    if (value.schemaVersion !== 1 || !RELEASE_ID.test(string(value.releaseId, 'actualChrome.releaseId'))) fail('actualChrome.schemaVersion');
    utc(value.createdUtc, 'actualChrome.createdUtc');
    exactKeys(value.captureAuthority, ['kind', 'sessionId', 'recordPath', 'recordSha256'], 'actualChrome.captureAuthority');
    if (value.captureAuthority.kind !== 'computer-use') fail('actualChrome.captureAuthority.kind');
    string(value.captureAuthority.sessionId, 'actualChrome.captureAuthority.sessionId');
    canonicalPath(value.captureAuthority.recordPath, 'actualChrome.captureAuthority.recordPath');
    sha(value.captureAuthority.recordSha256, 'actualChrome.captureAuthority.recordSha256');
    exactKeys(value.browser, ['name', 'version', 'executablePath'], 'actualChrome.browser');
    if (value.browser.name !== 'Google Chrome') fail('actualChrome.browser.name');
    string(value.browser.version, 'actualChrome.browser.version');
    canonicalPath(value.browser.executablePath, 'actualChrome.browser.executablePath');
    if (path.basename(value.browser.executablePath).toLowerCase() !== 'chrome.exe') fail('actualChrome.browser.executablePath');
    exactKeys(value.deployment, ['deploymentId', 'immutableUrl', 'aliasUrl'], 'actualChrome.deployment');
    string(value.deployment.deploymentId, 'actualChrome.deployment.deploymentId');
    validateUrl(value.deployment.immutableUrl, 'actualChrome.deployment.immutableUrl');
    validateUrl(value.deployment.aliasUrl, 'actualChrome.deployment.aliasUrl');
    for (const [key, zoom, suffix] of [['zoom200', 200, 'actual-chrome-200.png'], ['restore100', 100, 'actual-chrome-restored-100.png']]) {
        const row = value[key];
        exactKeys(row, ['observedUtc', 'zoomPercent', 'url', 'screenshotPath', 'screenshotSha256', 'visibleChecks'], `actualChrome.${key}`);
        utc(row.observedUtc, `actualChrome.${key}.observedUtc`);
        if (row.zoomPercent !== zoom) fail(`actualChrome.${key}.zoomPercent`);
        validateUrl(row.url, `actualChrome.${key}.url`);
        canonicalPath(row.screenshotPath, `actualChrome.${key}.screenshotPath`);
        if (!row.screenshotPath.endsWith(suffix)) fail(`actualChrome.${key}.screenshotPath`);
        sha(row.screenshotSha256, `actualChrome.${key}.screenshotSha256`);
        exactKeys(row.visibleChecks, ACTUAL_CHROME_VISIBLE_KEYS, `actualChrome.${key}.visibleChecks`);
        if (ACTUAL_CHROME_VISIBLE_KEYS.some((name) => row.visibleChecks[name] !== true)) fail(`actualChrome.${key}.visibleChecks`);
    }
    if (value.zoom200.url !== value.deployment.aliasUrl) fail('actualChrome.zoom200.url');
    if (value.restore100.url !== value.deployment.aliasUrl) fail('actualChrome.restore100.url');
    if (Date.parse(value.restore100.observedUtc) <= Date.parse(value.zoom200.observedUtc)) fail('actualChrome.restore100.order');
    if (expected.closureCreatedUtc !== undefined && Date.parse(value.zoom200.observedUtc) <= Date.parse(expected.closureCreatedUtc)) fail('actualChrome.zoom200.order');
    for (const [name, actual] of [['releaseId', value.releaseId], ['deploymentId', value.deployment.deploymentId], ['immutableUrl', value.deployment.immutableUrl], ['aliasUrl', value.deployment.aliasUrl]]) {
        if (expected[name] !== undefined && actual !== expected[name]) fail('actualChrome.deployment');
    }
    return value;
}

export function validateFinalReceipt(receipt, expected = {}) {
    exactKeys(receipt, FINAL_RECEIPT_KEYS, 'finalReceipt');
    if (receipt.schemaVersion !== 1 || receipt.status !== 'COMPLETE') fail('finalReceipt.status');
    if (!RELEASE_ID.test(string(receipt.releaseId, 'finalReceipt.releaseId'))) fail('finalReceipt.releaseId');
    utc(receipt.createdUtc, 'finalReceipt.createdUtc');
    canonicalPath(receipt.finalizerPath, 'finalReceipt.finalizerPath');
    canonicalPath(receipt.actualChromeEvidencePath, 'finalReceipt.actualChromeEvidencePath');
    for (const key of ['finalizerSha256', 'configSha256', 'campaignVerifierProofSha256', 'operationReceiptSha256', 'auditReceiptSha256', 'negativeReceiptSha256', 'closureReceiptSha256', 'actualChromeEvidenceSha256', 'acceptedManifestSha256', 'eventsSha256', 'finalEventSha256']) sha(receipt[key], `finalReceipt.${key}`);
    string(receipt.deploymentId, 'finalReceipt.deploymentId');
    validateUrl(receipt.immutableUrl, 'finalReceipt.immutableUrl');
    validateUrl(receipt.aliasUrl, 'finalReceipt.aliasUrl');
    exactKeys(receipt.fileGates, ['initial', 'operationFinalAlias', 'closureFinalAlias'], 'finalReceipt.fileGates');
    if (receipt.fileGates.initial !== '10/10' || receipt.fileGates.operationFinalAlias !== '5/5' || receipt.fileGates.closureFinalAlias !== '5/5') fail('finalReceipt.fileGates');
    if (receipt.smokeGate !== '6/6') fail('finalReceipt.smokeGate');
    if (receipt.negativeGate !== '12/12') fail('finalReceipt.negativeGate');
    if (!Array.isArray(receipt.screenshotBindings) || receipt.screenshotBindings.length !== 18) fail('finalReceipt.screenshotBindings');
    receipt.screenshotBindings.forEach((binding) => {
        exactKeys(binding, ['case', 'stage', 'path', 'pngSha256', 'oracleSha256', 'captureStartUtc', 'captureEndUtc'], 'finalReceipt.screenshotBinding');
        if (!expectedCaseLabels().includes(binding.case) || !STAGES.includes(binding.stage)) fail('finalReceipt.screenshotBinding.tuple');
        relativeFile(binding.path, 'finalReceipt.screenshotBinding.path'); sha(binding.pngSha256, 'finalReceipt.screenshotBinding.pngSha256'); sha(binding.oracleSha256, 'finalReceipt.screenshotBinding.oracleSha256'); utc(binding.captureStartUtc, 'finalReceipt.screenshotBinding.captureStartUtc'); utc(binding.captureEndUtc, 'finalReceipt.screenshotBinding.captureEndUtc');
        if (Date.parse(binding.captureEndUtc) <= Date.parse(binding.captureStartUtc)) fail('finalReceipt.screenshotBinding.timestamps');
    });
    exactKeys(receipt.actualChrome, ['browserName', 'browserVersion', 'deploymentId', 'url', 'observed200Utc', 'restored100Utc', 'zoomObserved', 'zoomRestored', 'evidencePath', 'evidenceSha256'], 'finalReceipt.actualChrome');
    if (receipt.actualChrome.browserName !== 'Google Chrome' || receipt.actualChrome.zoomObserved !== 200 || receipt.actualChrome.zoomRestored !== 100) fail('finalReceipt.actualChrome');
    string(receipt.actualChrome.browserVersion, 'finalReceipt.actualChrome.browserVersion'); string(receipt.actualChrome.deploymentId, 'finalReceipt.actualChrome.deploymentId'); validateUrl(receipt.actualChrome.url, 'finalReceipt.actualChrome.url'); utc(receipt.actualChrome.observed200Utc, 'finalReceipt.actualChrome.observed200Utc'); utc(receipt.actualChrome.restored100Utc, 'finalReceipt.actualChrome.restored100Utc'); canonicalPath(receipt.actualChrome.evidencePath, 'finalReceipt.actualChrome.evidencePath'); sha(receipt.actualChrome.evidenceSha256, 'finalReceipt.actualChrome.evidenceSha256');
    validateProductFiles(receipt.productFiles, 'finalReceipt.productFiles');
    for (const [key, actual] of Object.entries({ releaseId: receipt.releaseId, deploymentId: receipt.deploymentId, immutableUrl: receipt.immutableUrl, aliasUrl: receipt.aliasUrl })) if (expected[key] !== undefined && actual !== expected[key]) fail(`finalReceipt.${key}.binding`);
    return receipt;
}

export function auditAcceptedRun(options) {
    const resolved = resolveConfig(options.configPath ?? options);
    const config = resolved.base;
    const operationReceiptPath = canonicalPath(resolved.operationReceiptPath, 'operationReceipt.path');
    const suppliedOperation = options && typeof options === 'object' ? options.operationReceipt : undefined;
    const operationBytesHash = suppliedOperation ? sha256Bytes(Buffer.from(`${canonicalJson(suppliedOperation)}\n`)) : sha256File(operationReceiptPath);
    const operation = validateOperationReceipt(suppliedOperation ?? readJson(operationReceiptPath, 'operationReceipt.json'));
    if (operation.releaseId !== config.releaseId || operation.configSha256 !== sha256File(resolved.baseConfigPath)) fail('operationReceipt.binding');
    authenticateProcessCaptures(config, operation, resolved.baseConfigPath);
    const { campaign, deployment } = loadCommittedOperationAuthority(config);
    if (sha256File(config.nodeExePath) !== config.nodeExeSha256 || sha256File(config.wranglerJsPath) !== config.wranglerJsSha256) fail('config.toolingSha256');
    const root = fs.realpathSync(resolved.target);
    if (resolved.config.schemaVersion === 2 && fs.realpathSync(operation.accepted.realpath) !== root) fail('operationReceipt.accepted.realpath');
    const manifestPath = path.join(root, 'artifact-manifest.json');
    const eventsPath = path.join(root, 'runner-events.jsonl');
    noSymlinkAncestors(root, 'accepted.symlink'); noSymlinkAncestors(manifestPath, 'manifest.symlink'); noSymlinkAncestors(eventsPath, 'events.symlink');
    if (resolved.config.schemaVersion === 2 && (canonicalPath(operation.accepted.manifestPath, 'operationReceipt.manifestPath') !== manifestPath || canonicalPath(operation.accepted.eventsPath, 'operationReceipt.eventsPath') !== eventsPath)) fail('operationReceipt.acceptedPaths');
    const manifestHash = sha256File(manifestPath);
    const eventsHash = sha256File(eventsPath);
    const eventText = fs.readFileSync(eventsPath, 'utf8'); if (!eventText.endsWith('\n')) fail('events.termination');
    const events = eventText.slice(0, -1).split('\n').map((line) => JSON.parse(line));
    const eventValidation = validateEvents(events, operation);
    if (events[0].payload.releaseId !== config.releaseId) fail('events.operationStart.releaseId');
    const accepted = readJson(path.join(root, 'accepted-run.json'), 'acceptedRun.json');
    validateAcceptedRunSchema(accepted);
    if (accepted.releaseId !== config.releaseId || accepted.campaignRunId !== config.campaignRunId || accepted.sourceGitHead !== deployment.sourceGitHead || accepted.deploymentId !== deployment.deploymentId || accepted.immutableUrl !== deployment.immutableUrl || accepted.aliasUrl !== deployment.aliasUrl || accepted.attemptsPerCase !== 1 || accepted.retries !== 0 || accepted.skips !== 0 || accepted.screenshotCount !== 18) fail('acceptedRun.summary');
    if (canonicalJson(accepted.productFiles) !== canonicalJson(campaign.productFiles)) fail('acceptedRun.productFiles');
    if (accepted.tooling.runner.path !== 'scripts/run-public-smoke-v2.mjs' || accepted.tooling.library.path !== 'scripts/public-smoke-v2-lib.mjs') fail('acceptedRun.tooling.profile');
    if (accepted.tooling.runner.sha256 !== sha256File(path.join(config.sourceSnapshotDir, accepted.tooling.runner.path)) || accepted.tooling.library.sha256 !== sha256File(path.join(config.sourceSnapshotDir, accepted.tooling.library.path))) fail('acceptedRun.tooling');
    let acceptedProfile;
    if (accepted.tooling.runner.version === '1' && accepted.tooling.library.version === '1') acceptedProfile = 'legacy';
    else if (accepted.tooling.runner.version === '2' && accepted.tooling.library.version === '2') acceptedProfile = 'task2';
    else fail('acceptedRun.tooling.profile');
    if (acceptedProfile === 'task2' || accepted.tooling.playwright.path === 'node_modules/playwright/package.json') validatePlaywrightToolingDeclaration(resolvePlaywrightAuthority(config.sourceSnapshotDir), accepted.tooling.playwright);
    if (accepted.observationsPath !== 'observations.json' || accepted.eventsPath !== 'runner-events.jsonl') fail('acceptedRun.paths');
    const observationsPath = relativeAcceptedPath(root, accepted.observationsPath, 'acceptedRun.observationsPath');
    if (relativeAcceptedPath(root, accepted.eventsPath, 'acceptedRun.eventsPath') !== eventsPath) fail('acceptedRun.eventsPath');
    const cases = readJson(observationsPath, 'observations.json');
    if (!Array.isArray(cases) || cases.length !== 6) fail('observations.cardinality');
    const labels = cases.map((record) => record.label);
    if (canonicalJson(labels) !== canonicalJson(expectedCaseLabels())) fail('observations.matrix');
    cases.forEach((record, caseIndex) => {
        if (acceptedProfile === 'task2') validateTask2Case(record); else validateCaseFull(record);
        const expectedUrl = record.originKind === 'immutable' ? deployment.immutableUrl : deployment.aliasUrl;
        if (record.requestedUrl !== expectedUrl || record.finalUrl !== expectedUrl) fail('case.url');
        const boundary = eventValidation.boundaries.get(record.label);
        if (boundary.start.payload.requestedUrl !== record.requestedUrl || boundary.start.utc !== record.startedUtc || boundary.start.monotonicMs !== record.startedMonotonicMs || boundary.finish.payload.finalUrl !== record.finalUrl || boundary.finish.utc !== record.finishedUtc || boundary.finish.monotonicMs !== record.finishedMonotonicMs) fail('events.caseBoundaryBinding');
        if (Date.parse(record.startedUtc) < Date.parse(accepted.startedUtc) || Date.parse(record.finishedUtc) > Date.parse(accepted.finishedUtc) || record.startedMonotonicMs < accepted.startedMonotonicMs || record.finishedMonotonicMs > accepted.finishedMonotonicMs) fail('case.operationTime');
        if (caseIndex > 0 && (Date.parse(record.startedUtc) < Date.parse(cases[caseIndex - 1].finishedUtc) || record.startedMonotonicMs < cases[caseIndex - 1].finishedMonotonicMs)) fail('case.order');
        record.actions.forEach((action, actionIndex) => {
            if (action.resultingUrl !== record.finalUrl || (actionIndex > 0 && action.preStateSha256 !== record.actions[actionIndex - 1].postStateSha256)) fail('actions.stateChain');
            const event = eventValidation.trusted.get(record.label)[actionIndex];
            if (!event || canonicalJson(event.payload) !== canonicalJson({ actionSeq: action.seq, api: action.api, target: action.target, preStateSha256: action.preStateSha256, postStateSha256: action.postStateSha256, resultingUrl: action.resultingUrl }) || event.utc !== action.utc || event.monotonicMs !== action.monotonicMs) fail('events.actionBinding');
        });
        record.screenshots.forEach((screenshot, screenshotIndex) => validateScreenshot(record, root, screenshot, screenshotIndex, eventValidation.eventMap));
    });
    const initialProbe = validateProbe(root, operation.fileProbes.initialPath, 'initial', ['immutable', 'alias'], campaign, deployment);
    const pre = validateWranglerCapture(root, operation.cloudflareReads.pre.capturePath, 'pre', config, deployment);
    const mid = validateWranglerCapture(root, operation.cloudflareReads.mid.capturePath, 'mid', config, deployment);
    const post = validateWranglerCapture(root, operation.cloudflareReads.post.capturePath, 'post', config, deployment);
    const finalProbe = validateProbe(root, operation.fileProbes.finalAliasPath, 'final-alias', ['alias'], campaign, deployment);
    if (Date.parse(operation.campaignVerifier.finishedUtc) > Date.parse(initialProbe.probe.startedUtc)) fail('campaignVerifier.order');
    if (Date.parse(operation.worker.startedUtc) > Date.parse(initialProbe.probe.startedUtc) || Date.parse(operation.worker.finishedUtc) < Date.parse(operation.accepted.publishedUtc) || operation.worker.finishedMonotonicMs - operation.worker.startedMonotonicMs >= 900000) fail('worker.order');
    if (Date.parse(initialProbe.probe.finishedUtc) > Date.parse(pre.capture.startedUtc) || Date.parse(pre.capture.finishedUtc) > Date.parse(cases[0].startedUtc)) fail('cloudflare.pre.order');
    if (Date.parse(cases[2].finishedUtc) > Date.parse(mid.capture.startedUtc) || Date.parse(mid.capture.finishedUtc) > Date.parse(cases[3].startedUtc)) fail('cloudflare.mid.order');
    if (Date.parse(cases[5].finishedUtc) > Date.parse(post.capture.startedUtc) || Date.parse(post.capture.finishedUtc) > Date.parse(finalProbe.probe.startedUtc)) fail('cloudflare.post.order');
    if (Date.parse(finalProbe.probe.finishedUtc) > Date.parse(operation.accepted.publishedUtc) || Date.parse(operation.accepted.publishedUtc) > Date.parse(operation.worker.finishedUtc) || Date.parse(operation.worker.finishedUtc) > Date.parse(operation.createdUtc)) fail('operationReceipt.publicationOrder');
    for (const phase of ['pre', 'mid', 'post']) if (operation.cloudflareReads[phase].deploymentId !== deployment.deploymentId) fail(`cloudflare.${phase}DeploymentId`);
    if (operation.cloudflareReads.pre.captureSha256 !== sha256File(pre.captureFile) || operation.cloudflareReads.mid.captureSha256 !== sha256File(mid.captureFile) || operation.cloudflareReads.post.captureSha256 !== sha256File(post.captureFile)) fail('cloudflare.operationReceiptBinding');
    if (operation.fileProbes.initialSha256 !== sha256File(initialProbe.file) || operation.fileProbes.finalAliasSha256 !== sha256File(finalProbe.file)) fail('fileGate.operationReceiptBinding');
    const screenshotBindings = cases.flatMap((record) => record.screenshots.map((screenshot) => ({ case: screenshot.caseLabel, stage: screenshot.stage, path: screenshot.relativePath, pngSha256: screenshot.sha256, oracleSha256: screenshot.oracleSnapshotSha256, captureStartUtc: screenshot.captureStartedUtc, captureEndUtc: screenshot.captureFinishedUtc })));
    if (canonicalJson(screenshotBindings) !== canonicalJson(operation.screenshotBindings)) fail('screenshot.operationReceiptBinding');
    if (eventsHash !== operation.accepted.eventsSha256 || eventValidation.finalEventSha256 !== operation.accepted.finalEventSha256) fail('events.operationReceiptBinding');
    const manifest = validateManifest(root, readJson(manifestPath, 'manifest.json')); validateAcceptedManifest(manifest);
    if (manifestHash !== operation.accepted.manifestSha256 || manifest.releaseId !== config.releaseId) fail('manifest.operationReceiptBinding');
    const treeDigest = sha256Bytes(canonicalJson({ files: manifest.files, manifestSha256: manifestHash }));
    if (operation.accepted.treeDigest !== treeDigest) fail('manifest.treeDigest');
    const receipt = {
        schemaVersion: 1, releaseId: config.releaseId, status: 'VERIFIED', createdUtc: new Date().toISOString(), auditedTargetRealpath: root,
        configSha256: sha256File(resolved.configPath), operationReceiptSha256: operationBytesHash, acceptedManifestSha256: manifestHash, eventsSha256: eventsHash,
        finalEventSha256: eventValidation.finalEventSha256, deploymentId: accepted.deploymentId, passedCases: 6, totalCases: 6, controlPlaneReads: 3,
        initialFileGate: { passed: 10, total: 10 }, finalAliasGate: { passed: 5, total: 5 }, screenshotBindings,
    };
    validateAuditReceipt(receipt);
    return receipt;
}

export function auditorModulePath() {
    return fileURLToPath(new URL('./verify-public-smoke-v2.mjs', import.meta.url));
}
