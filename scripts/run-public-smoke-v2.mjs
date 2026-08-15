import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { chromium, firefox, webkit } from 'playwright';

import {
    canonicalJson,
    createRunnerEventLedger,
    enforceStrictDeadline,
    expectedCaseLabels,
    validateOperationConfig,
    loadOperationAuthority,
    resolvePlaywrightAuthority,
    validateOuterAuthority,
    validateWranglerRows,
    validateTask2Case,
} from './public-smoke-v2-lib.mjs';

export async function readDocumentSnapshot(page) {
    return page.evaluate(async () => {
        await document.fonts.ready;
        const rows = [...document.querySelectorAll('#terminal-output .terminal-line')].map((element) => ({
            text: element.textContent ?? '',
            kind: element.getAttribute('data-terminal-kind') ?? '',
            context: element.getAttribute('data-dialogue-context') ?? '',
            index: element.getAttribute('data-dialogue-index') ?? '',
            pseudoLabel: getComputedStyle(element, '::before').content,
        }));
        const commandRow = rows.find((row) => row.kind === 'command');
        const systemRow = rows.find((row) => row.kind === 'system');
        const roastRow = rows.find((row) => row.context === 'puzzle' && row.index === '0');
        const backgroundInert = {
            header: Boolean(document.querySelector('body > header')?.inert),
            dashboard: Boolean(document.querySelector('body > .dashboard')?.inert),
            intrusionBanner: Boolean(document.querySelector('body > .intrusion-banner')?.inert),
            mainGrid: Boolean(document.querySelector('body > .main-grid')?.inert),
        };
        return {
            url: location.href,
            title: document.title,
            readyState: document.readyState,
            activeElementId: document.activeElement?.id ?? '',
            rows,
            fairSignature: {
                command: commandRow?.text ?? '', commandKind: commandRow?.kind ?? '',
                system: systemRow?.text ?? '', systemKind: systemRow?.kind ?? '',
                roast: roastRow?.text ?? '', roastKind: roastRow?.kind ?? '', pseudoLabel: roastRow?.pseudoLabel ?? '',
            },
            tabs: {
                wifiAriaSelected: document.querySelector('#tab-wifi')?.getAttribute('aria-selected') ?? '',
                wifiTabIndex: document.querySelector('#tab-wifi')?.getAttribute('tabindex') ?? '',
                cpuAriaSelected: document.querySelector('#tab-cpu')?.getAttribute('aria-selected') ?? '',
                cpuTabIndex: document.querySelector('#tab-cpu')?.getAttribute('tabindex') ?? '',
                panelAriaLabelledby: document.querySelector('#puzzle-panel')?.getAttribute('aria-labelledby') ?? '',
            },
            npc: {
                icon: document.querySelector('#npc-icon')?.textContent ?? '',
                name: document.querySelector('#npc-name')?.textContent ?? '',
                message: document.querySelector('#npc-message')?.textContent ?? '',
            },
            ending: {
                role: document.querySelector('#ending-overlay')?.getAttribute('role') ?? '',
                ariaModal: document.querySelector('#ending-overlay')?.getAttribute('aria-modal') ?? '',
                ariaLabelledby: document.querySelector('#ending-overlay')?.getAttribute('aria-labelledby') ?? '',
                accessibleName: document.querySelector('#ending-process-heading')?.textContent ?? '',
                text: document.querySelector('#ending-overlay')?.textContent ?? '',
                tokens: [
                    ...(document.querySelector('.ending-process-code')?.textContent?.match(/[A-Z ]+:[ ]*[0-9]+/) ?? []),
                    ...(document.querySelector('.ending-financial-code')?.textContent?.match(/[A-Z ]+:[ ]*[0-9]+/) ?? []),
                    ...[...document.querySelectorAll('.ending-summary > div:not(#ending-incident-cost)')].flatMap((element) => element.textContent?.match(/[+-]\$[0-9,]+/) ?? []),
                    ...(document.querySelector('#ending-overlay p')?.textContent?.match(/^[^:]+/) ?? []),
                    ...(document.querySelectorAll('#ending-overlay p')[1]?.textContent?.match(/:\s*([^()]+)/)?.slice(1) ?? []),
                ].map((value) => value.trim()),
            },
            controls: [...document.querySelectorAll('button')].map((element) => ({ id: element.id, name: element.getAttribute('aria-label') || element.textContent?.trim() || '' })),
            backgroundInert,
        };
    });
}

const FAIR_PING_ROWS = [
    { text: 'archon@stone-igloo:~$ ping 8.8.8.8', kind: 'command', context: '', index: '' },
    { text: '64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=14.2 ms\n케이블이 빠져 있었습니다. 네트워크를 복구했습니다.', kind: 'system', context: '', index: '' },
    { text: '아콘 🐧 // 지식은 레버리지가 아니다 애송아.', kind: 'archon', context: 'puzzle', index: '1' },
];

export function deriveFairPingProvenance(beforeRowCount, afterRows) {
    if (!Number.isInteger(beforeRowCount) || beforeRowCount < 0 || !Array.isArray(afterRows)) throw new Error('fairPing.provenance.boundary');
    const rows = afterRows.slice(beforeRowCount);
    if (rows.length !== FAIR_PING_ROWS.length) throw new Error('fairPing.provenance.cardinality');
    rows.forEach((row, index) => {
        const expected = FAIR_PING_ROWS[index];
        for (const key of ['text', 'kind', 'context', 'index']) if (row?.[key] !== expected[key]) throw new Error(`fairPing.provenance.rows.${index}.${key}`);
        if (typeof row.pseudoLabel !== 'string') throw new Error(`fairPing.provenance.rows.${index}.pseudoLabel`);
    });
    return {
        command: rows[0].text, commandKind: rows[0].kind,
        system: rows[1].text, systemKind: rows[1].kind,
        roast: rows[2].text, roastKind: rows[2].kind,
        provenance: { beforeRowCount, rows },
    };
}

export async function readVisibilityPrimitives(page, selector) {
    return page.evaluate((targetSelector) => {
        const element = document.querySelector(targetSelector);
        if (!element) throw new Error(`missing visibility target: ${targetSelector}`);
        const computed = getComputedStyle(element);
        const clientRects = [...element.getClientRects()].map((rect) => ({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
        }));
        const first = clientRects[0] ?? { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
        const visibleLeft = Math.max(0, first.left);
        const visibleRight = Math.min(innerWidth, first.right);
        const visibleTop = Math.max(0, first.top);
        const visibleBottom = Math.min(innerHeight, first.bottom);
        const intersectionArea = Math.max(0, visibleRight - visibleLeft) * Math.max(0, visibleBottom - visibleTop);
        const elementArea = Math.max(0, first.width) * Math.max(0, first.height);
        const centerX = first.left + first.width / 2;
        const centerY = first.top + first.height / 2;
        const hit = centerX >= 0 && centerX < innerWidth && centerY >= 0 && centerY < innerHeight
            ? document.elementFromPoint(centerX, centerY)
            : null;
        return {
            hiddenAttribute: element.hidden,
            display: computed.display,
            position: computed.position,
            visibility: computed.visibility,
            opacity: Number(computed.opacity),
            clientRects,
            intersectionArea,
            intersectionRatio: elementArea === 0 ? 0 : intersectionArea / elementArea,
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
            centerX,
            centerY,
            hitElementId: hit?.id ?? '',
            hitIsSelfOrDescendant: hit === element || Boolean(hit && element.contains(hit)),
        };
    }, selector);
}

export async function readStatePrimitives(page) {
    return page.evaluate(() => {
        const text = (selector) => document.querySelector(selector)?.textContent ?? '';
        const attribute = (selector, name) => document.querySelector(selector)?.getAttribute(name) ?? '';
        const numberFrom = (selector) => Number.parseInt(text(selector).match(/-?[0-9]+/)?.[0] ?? '0', 10);
        let quoteStorage = null;
        try {
            quoteStorage = localStorage.getItem('penguin-exit-0:quote-discovery:v2');
        } catch {
            quoteStorage = null;
        }
        return {
            url: location.href,
            activeElementId: document.activeElement?.id ?? '',
            units: numberFrom('#val-units'),
            stars: numberFrom('#val-stars'),
            incidentCost: numberFrom('#val-cost'),
            activeIntrusion: !document.querySelector('#intrusion-banner') || getComputedStyle(document.querySelector('#intrusion-banner')).display === 'none' ? null
                : text('#intrusion-title').includes('Copilot') ? 'copilot'
                    : text('#intrusion-title').includes('Codex') ? 'codex'
                        : text('#intrusion-title').includes('Gemini') ? 'gemini'
                            : text('#intrusion-title').includes('CEO') ? 'ceo' : null,
            intrusionTitle: text('#intrusion-title'),
            intrusionBody: text('#intrusion-msg'),
            produceDisabled: Boolean(document.querySelector('#btn-produce')?.disabled),
            produceAccessibleName: attribute('#btn-produce', 'aria-label'),
            quoteCounterText: text('#quote-collection'),
            quoteStorage,
            terminalText: text('#terminal-output'),
            bodyText: document.body?.innerText ?? '',
        };
    });
}

export async function readScreenshotOracle(page) {
    return page.evaluate(() => ({
        url: location.href,
        viewport: { width: innerWidth, height: innerHeight },
        activeElementId: document.activeElement?.id ?? '',
        bodyText: document.body?.innerText ?? '',
        quoteCounterText: document.querySelector('#quote-collection')?.textContent ?? '',
        endingText: document.querySelector('#ending-overlay')?.textContent ?? '',
    }));
}

function sha256Bytes(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function utcNow() {
    return new Date().toISOString();
}

function monotonicNow() {
    return Math.floor(performance.now());
}

function fsyncFile(file) {
    const descriptor = fs.openSync(file, 'r+');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function fsyncDirectory(directory) {
    const descriptor = fs.openSync(directory, 'r');
    try {
        fs.fsyncSync(descriptor);
    } catch (error) {
        if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
    } finally {
        fs.closeSync(descriptor);
    }
}

function walkRegularFiles(root, current = root) {
    const files = [];
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
        const absolute = path.join(current, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`publication.symlink: ${absolute}`);
        if (entry.isDirectory()) files.push(...walkRegularFiles(root, absolute));
        else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
        else throw new Error(`publication.regular: ${absolute}`);
    }
    return files;
}

export async function publishAcceptedStage({ stageDir, acceptedDir, releaseId }) {
    if (path.resolve(stageDir) === path.resolve(acceptedDir) || fs.existsSync(acceptedDir)) throw new Error('publication.acceptedAbsent');
    if (!fs.existsSync(stageDir) || fs.existsSync(path.join(stageDir, 'artifact-manifest.json'))) throw new Error('publication.stage');
    const files = walkRegularFiles(stageDir).map((relative) => {
        const absolute = path.join(stageDir, ...relative.split('/'));
        fsyncFile(absolute);
        const bytes = fs.statSync(absolute).size;
        return { path: relative, bytes, sha256: sha256Bytes(fs.readFileSync(absolute)) };
    });
    const payload = { schemaVersion: 1, releaseId, files };
    const manifest = { ...payload, manifestPayloadSha256: sha256Bytes(canonicalJson(payload)) };
    const manifestPath = path.join(stageDir, 'artifact-manifest.json');
    fs.writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`, { flag: 'wx' });
    fsyncFile(manifestPath);
    for (const directory of walkDirectories(stageDir).sort((left, right) => right.length - left.length)) fsyncDirectory(directory);
    fsyncDirectory(path.dirname(stageDir));
    fs.renameSync(stageDir, acceptedDir);
    fsyncDirectory(path.dirname(acceptedDir));
    return manifest;
}

function walkDirectories(root, current = root) {
    const directories = [current];
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) directories.push(...walkDirectories(root, path.join(current, entry.name)));
    }
    return directories;
}

export async function publishFailureStage({ stageDir, failureRoot, basicUtc }) {
    if (!fs.existsSync(stageDir) || fs.existsSync(path.join(stageDir, 'artifact-manifest.json'))) throw new Error('publication.failureStage');
    const suffix = crypto.randomBytes(16).toString('hex');
    const failureDir = path.join(failureRoot, `public-smoke-v2-failure-${basicUtc}-${suffix}`);
    if (fs.existsSync(failureDir)) throw new Error('publication.failureAbsent');
    fs.mkdirSync(failureRoot, { recursive: true });
    fs.renameSync(stageDir, failureDir);
    fsyncDirectory(path.dirname(failureDir));
    return failureDir;
}

export function enforceActiveDeadline(work, timeoutMs, invariant, cancel = () => {}) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cancel(); reject(new Error(invariant)); }, timeoutMs);
        Promise.resolve(work).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
}

function stateRecord(raw) {
    return {
        units: raw.units,
        stars: raw.stars,
        incidentCost: Math.abs(raw.incidentCost),
        activeIntrusion: raw.activeIntrusion,
    };
}

function quoteSnapshot(raw) {
    const serialized = raw.quoteStorage ?? '';
    return {
        counterText: raw.quoteCounterText,
        counter: Number.parseInt(raw.quoteCounterText.match(/[0-9]+/)?.[0] ?? '0', 10),
        serialized,
        parsed: JSON.parse(serialized),
    };
}

function eventRecord(ledger, value) {
    return ledger.append(value);
}

async function screenshotEvidence({ page, label, stage, screenshotDir, ledger }) {
    const ending = stage === 'ending';
    const viewport = ending ? { width: 640, height: 360 } : { width: 320, height: 640 };
    await page.setViewportSize(viewport);
    const oracle = await readScreenshotOracle(page);
    const oracleSha256 = sha256Bytes(canonicalJson(oracle));
    const relativePath = `screenshots/${label}-${ending ? 'ending-640' : `${stage}-320`}.png`;
    const absolutePath = path.join(screenshotDir, path.basename(relativePath));
    fs.mkdirSync(screenshotDir, { recursive: true });
    const captureStartedUtc = utcNow();
    eventRecord(ledger, { utc: captureStartedUtc, monotonicMs: monotonicNow(), type: 'screenshot-oracle', case: label, payload: { stage, oracleSha256 } });
    await page.screenshot({ path: absolutePath });
    const captureFinishedUtc = utcNow();
    const bytes = fs.statSync(absolutePath).size;
    const pngSha256 = sha256Bytes(fs.readFileSync(absolutePath));
    eventRecord(ledger, { utc: captureFinishedUtc, monotonicMs: monotonicNow(), type: 'screenshot-written', case: label, payload: { stage, path: relativePath, pngSha256, oracleSha256 } });
    return {
        caseLabel: label,
        stage,
        relativePath,
        viewport,
        requestedOrigin: new URL(page.url()).origin,
        finalUrl: page.url(),
        oracleSnapshotSha256: oracleSha256,
        captureStartedUtc,
        captureFinishedUtc,
        bytes,
        sha256: pngSha256,
    };
}

export async function runCase({ browserType, engine, originKind, originUrl, screenshotDir, eventLedger }) {
    const label = `${engine}-${originKind}`;
    if (!expectedCaseLabels().includes(label)) throw new Error('runner.case.identity');
    const browser = await browserType.launch({ headless: true });
    const contextStartedMonotonicMs = monotonicNow();
    const startedUtc = utcNow();
    const context = await createContextWithinDeadline(browser, { viewport: { width: 320, height: 640 } }, 120000);
    const caseWatchdog = setTimeout(() => { void context.close(); void browser.close(); }, Math.max(1, 120000 - (monotonicNow() - contextStartedMonotonicMs)));
    const page = await context.newPage();
    const actions = [];
    const errors = { console: [], page: [], requestFailed: [], http: [], external: [] };
    const origin = new URL(originUrl).origin;
    page.on('console', (message) => { if (message.type() === 'error') errors.console.push({ type: message.type(), text: message.text() }); });
    page.on('pageerror', (error) => errors.page.push({ name: error.name, message: error.message, stack: error.stack ?? '' }));
    page.on('requestfailed', (request) => errors.requestFailed.push({ url: request.url(), method: request.method(), errorText: request.failure()?.errorText ?? '' }));
    page.on('response', (response) => { if (response.status() >= 400) errors.http.push({ url: response.url(), status: response.status() }); });
    page.on('request', (request) => {
        const requestUrl = new URL(request.url());
        if (!['data:', 'blob:'].includes(requestUrl.protocol) && requestUrl.origin !== origin) errors.external.push({ url: request.url(), method: request.method() });
    });
    eventRecord(eventLedger, { utc: startedUtc, monotonicMs: contextStartedMonotonicMs, type: 'case-start', case: label, payload: { engine, originKind, requestedUrl: originUrl } });

    const state = () => readStatePrimitives(page);
    const trusted = async (api, target, invoke) => {
        const before = await state();
        const beforeSha256 = sha256Bytes(canonicalJson(before));
        const prior = actions.at(-1);
        if (prior && prior.postStateSha256 !== beforeSha256) {
            prior.postStateSha256 = beforeSha256;
            prior.resultingUrl = page.url();
            eventLedger.finalizeTrustedInput(label, prior.seq, beforeSha256, prior.resultingUrl);
        }
        await invoke();
        const after = await state();
        const action = {
            seq: actions.length + 1,
            utc: utcNow(),
            monotonicMs: monotonicNow(),
            api,
            target,
            preStateSha256: beforeSha256,
            postStateSha256: sha256Bytes(canonicalJson(after)),
            resultingUrl: page.url(),
        };
        actions.push(action);
        eventRecord(eventLedger, { utc: action.utc, monotonicMs: action.monotonicMs, type: 'trusted-input', case: label, payload: { actionSeq: action.seq, api, target, preStateSha256: action.preStateSha256, postStateSha256: action.postStateSha256, resultingUrl: action.resultingUrl } });
        return after;
    };
    const click = (locator, target) => trusted('locator.click', target, () => locator.click());
    const press = (key) => trusted('keyboard.press', key, () => page.keyboard.press(key));

    try {
        await page.goto(originUrl, { waitUntil: 'load' });
        await readDocumentSnapshot(page);
        const initialDocument = await readDocumentSnapshot(page);
        const initialVisibility = await readVisibilityPrimitives(page, '#ending-overlay');
        const initialState = await state();
        const initial = {
            endingVisibility: initialVisibility,
            endingRole: initialDocument.ending.role,
            endingAriaModal: initialDocument.ending.ariaModal,
            endingAriaLabelledby: initialDocument.ending.ariaLabelledby,
            endingAccessibleName: initialDocument.ending.accessibleName,
            backgroundInert: initialDocument.backgroundInert,
            activeElementId: initialDocument.activeElementId,
            produceDisabled: initialState.produceDisabled,
            produceAccessibleName: initialState.produceAccessibleName,
        };
        const screenshots = [await screenshotEvidence({ page, label, stage: 'initial', screenshotDir, ledger: eventLedger })];

        await click(page.locator('#tab-wifi'), '#tab-wifi');
        await click(page.getByRole('button', { name: '3. systemctl restart nginx (무작정 재시작)' }), 'role=button[name="3. systemctl restart nginx (무작정 재시작)"]');
        await click(page.locator('#tab-cpu'), '#tab-cpu');
        await page.locator('#terminal-output [data-terminal-kind="system"]').filter({ hasText: 'Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.' }).waitFor();
        await page.locator('#terminal-output [data-dialogue-context="puzzle"][data-dialogue-index="0"]').waitFor();
        const signatureDocument = await readDocumentSnapshot(page);
        const signature = { ...signatureDocument.fairSignature, tabs: { ...signatureDocument.tabs, terminalRowsPersisted: Object.values(signatureDocument.fairSignature).every(Boolean) } };
        screenshots.push(await screenshotEvidence({ page, label, stage: 'progress', screenshotDir, ledger: eventLedger }));
        const afterBad = quoteSnapshot(await state());
        const beforeReload = quoteSnapshot(await state());
        await page.reload({ waitUntil: 'load' });
        await readDocumentSnapshot(page);
        const afterReload = quoteSnapshot(await state());

        await click(page.locator('#tab-wifi'), '#tab-wifi');
        const beforeFairDocument = await readDocumentSnapshot(page);
        const beforeFairRowCount = beforeFairDocument.rows.length;
        await click(page.getByRole('button', { name: '1. ping 8.8.8.8 (안전한 SRE 진단)' }), 'role=button[name="1. ping 8.8.8.8 (안전한 SRE 진단)"]');
        await page.locator('#terminal-output [data-terminal-kind="system"]').filter({ hasText: '케이블이 빠져 있었습니다.' }).waitFor();
        await page.locator('#terminal-output [data-dialogue-context="puzzle"][data-dialogue-index="1"]').waitFor();
        const afterFairDocument = await readDocumentSnapshot(page);
        signature.fairPing = deriveFairPingProvenance(beforeFairRowCount, afterFairDocument.rows);
        const afterFair = quoteSnapshot(await state());
        await page.locator('#npc-card').scrollIntoViewIfNeeded();
        const npcDocument = await readDocumentSnapshot(page);
        const npc = { ...npcDocument.npc, visibility: await readVisibilityPrimitives(page, '#npc-card') };

        const intrusions = [];
        let penalty;
        for (let ordinal = 0; ordinal < 4; ordinal += 1) {
            for (let count = 0; count < 5; count += 1) await click(page.locator('#btn-produce'), '#btn-produce');
            const beforeRaw = await state();
            const intrusionDocument = await readDocumentSnapshot(page);
            const aiRows = intrusionDocument.rows.filter((row) => row.context === 'ai');
            const resolutionControlName = intrusionDocument.controls.find(({ id }) => id === (ordinal === 0 ? 'btn-accept-penalty' : 'btn-revert'))?.name ?? '';
            const resolutionTarget = ordinal === 0 ? '#btn-accept-penalty' : '#btn-revert';
            const resolutionLocator = page.locator(resolutionTarget);
            await click(resolutionLocator, resolutionTarget);
            const afterRaw = await state();
            const before = stateRecord(beforeRaw);
            const after = stateRecord(afterRaw);
            const intrusion = {
                ordinal: ordinal + 1,
                type: before.activeIntrusion,
                title: beforeRaw.intrusionTitle,
                body: beforeRaw.intrusionBody,
                triggerActionSeq: 10 + ordinal * 6,
                aiQuoteText: aiRows.at(-1)?.text ?? '',
                aiQuoteKind: aiRows.at(-1)?.kind ?? '',
                aiQuotesBefore: ordinal,
                aiQuotesAfter: aiRows.length,
                produceAccessibleName: beforeRaw.produceAccessibleName,
                resolutionActionSeq: 11 + ordinal * 6,
                resolutionControlName,
                before,
                after,
            };
            intrusions.push(intrusion);
            if (ordinal === 0) penalty = { actionSeq: 11, controlAccessibleName: resolutionControlName, before, after, starDelta: after.stars - before.stars };
        }

        const recoveries = [];
        for (let index = 0; index < 47; index += 1) {
            const beforeRaw = await state();
            await click(page.locator('#btn-produce'), '#btn-produce');
            const afterRaw = await state();
            const before = stateRecord(beforeRaw);
            const after = stateRecord(afterRaw);
            recoveries.push({ actionSeq: 30 + index, controlAccessibleName: beforeRaw.produceAccessibleName, before, after, starDelta: after.stars - before.stars });
        }
        await page.locator('#ending-overlay').waitFor({ state: 'visible' });
        const endingInitialFocus = (await readDocumentSnapshot(page)).activeElementId;
        await press('Tab');
        const tabFocusId = (await readDocumentSnapshot(page)).activeElementId;
        await press('Shift+Tab');
        const endingDocument = await readDocumentSnapshot(page);
        const endingState = await state();
        const ending = {
            visibility: await readVisibilityPrimitives(page, '#ending-overlay'),
            role: endingDocument.ending.role,
            ariaModal: endingDocument.ending.ariaModal,
            ariaLabelledby: endingDocument.ending.ariaLabelledby,
            accessibleName: endingDocument.ending.accessibleName,
            initialFocusId: endingInitialFocus,
            tabFocusId,
            shiftTabFocusId: endingDocument.activeElementId,
            backgroundInert: endingDocument.backgroundInert,
            produceDisabled: endingState.produceDisabled,
            produceAccessibleName: endingState.produceAccessibleName,
            tokens: endingDocument.ending.tokens,
        };
        screenshots.push(await screenshotEvidence({ page, label, stage: 'ending', screenshotDir, ledger: eventLedger }));
        const finishedMonotonicMs = monotonicNow();
        enforceStrictDeadline(finishedMonotonicMs - contextStartedMonotonicMs, 120000, 'case.deadline');
        const finishedUtc = utcNow();
        eventRecord(eventLedger, { utc: finishedUtc, monotonicMs: finishedMonotonicMs, type: 'case-finish', case: label, payload: { actionCount: actions.length, finalUrl: page.url() } });
        return {
            observation: {
                schemaVersion: 2,
                label,
                engine,
                browserVersion: browser.version(),
                originKind,
                requestedUrl: originUrl,
                finalUrl: page.url(),
                attempt: 1,
                startedUtc,
                finishedUtc,
                startedMonotonicMs: contextStartedMonotonicMs,
                finishedMonotonicMs,
                actions,
                initial,
                signature,
                quotePersistence: { afterBad, beforeReload, afterReload, afterFair },
                npc,
                intrusions,
                penalty,
                recoveries,
                ending,
                errors,
                screenshots,
            },
        };
    } finally {
        clearTimeout(caseWatchdog);
        await context.close();
        await browser.close();
    }
}

export async function createContextWithinDeadline(browser, options, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            browser.newContext({ ...options, serviceWorkers: 'block' }),
            new Promise((_, reject) => { timer = setTimeout(async () => { await browser.close(); reject(new Error('case.deadline')); }, timeoutMs); }),
        ]);
    } finally { clearTimeout(timer); }
}

export async function runAcceptedSmoke(options) {
    const ledger = options.eventLedger ?? createRunnerEventLedger();
    const now = options.monotonicNow ?? monotonicNow;
    const caseRunner = options.caseRunner ?? runCase;
    const browserTypes = options.browserTypes ?? { chromium, firefox, webkit };
    const startedMonotonicMs = now();
    eventRecord(ledger, { utc: utcNow(), monotonicMs: startedMonotonicMs, type: 'operation-start', case: null, payload: { releaseId: options.releaseId, matrix: expectedCaseLabels() } });
    const observations = [];
    for (const label of expectedCaseLabels()) {
        const [engine, originKind] = label.split('-');
        const result = await caseRunner({
            browserType: browserTypes[engine],
            engine,
            originKind,
            originUrl: options[`${originKind}Url`],
            screenshotDir: options.screenshotDir,
            eventLedger: ledger,
        });
        if (result?.observation?.label !== label || result.observation.attempt !== 1 || result.observation.actions?.length !== 78 || result.observation.screenshots?.length !== 3) throw new Error(`runner.case.contract: ${label}`);
        observations.push(result.observation);
        await options.onCaseFinished?.(observations.length);
    }
    eventRecord(ledger, { utc: utcNow(), monotonicMs: now(), type: 'operation-finish', case: null, payload: { caseCount: 6, screenshotCount: 18 } });
    enforceStrictDeadline(now() - startedMonotonicMs, 900000, 'operation.deadline');
    const events = ledger.records();
    if (events.length !== 518) throw new Error(`events.cardinality: ${events.length}`);
    return { observations, events };
}

export function validateWorkerOwnedArtifacts({ observations, events }) {
    try {
        if (!Array.isArray(observations) || observations.length !== 6 || !Array.isArray(events) || events.length !== 518) throw new Error('cardinality');
        observations.forEach((observation) => {
            if (!observation?.signature?.fairPing?.provenance) throw new Error('fairPing.provenance');
            validateTask2Case(observation);
        });
    } catch (error) { throw new Error(`worker.semantic: ${error.message}`); }
    return true;
}

function parseWorkerArgv(argv) {
    if (argv.length !== 2 || argv[0] !== '--config' || !path.isAbsolute(argv[1])) throw new Error('worker.argv');
    return path.resolve(argv[1]);
}

async function defaultCreateStageDir(config) {
    fs.mkdirSync(config.releaseRoot, { recursive: true });
    const stage = path.join(config.releaseRoot, `.public-smoke-v2.stage-${crypto.randomBytes(16).toString('hex')}`);
    fs.mkdirSync(stage, { recursive: false });
    return stage;
}

const PRODUCT_PATHS = ['/', '/content.js', '/game-core.js', '/script.js', `/${'style'}.css`, '/assets/dangerous-alliance-ssh.png', '/assets/ending-tuna-acquisition.png'];

export async function fetchWithinBudget(url, timeoutMs, fetchImpl = fetch) {
    if (!(timeoutMs > 0)) throw new Error('operation.deadline');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('operation.deadline')), timeoutMs);
    try { return await fetchImpl(url, { redirect: 'manual', cache: 'no-store', signal: controller.signal }); }
    finally { clearTimeout(timeout); }
}

export async function fetchProbeBytesWithinDeadline(url, { deadlineMonotonicMs, monotonicNow = () => performance.now(), fetchImpl = fetch, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout }) {
    const remainingMs = deadlineMonotonicMs - monotonicNow();
    if (!(remainingMs > 0)) throw new Error('operation.deadline');
    const controller = new AbortController();
    const timeout = setTimeoutImpl(() => controller.abort(new Error('operation.deadline')), remainingMs);
    try {
        const response = await fetchImpl(url, { redirect: 'manual', cache: 'no-store', signal: controller.signal });
        const body = Buffer.from(await response.arrayBuffer());
        return { response, body };
    } finally { clearTimeoutImpl(timeout); }
}

async function collectProbe(phase, origins, { config, stageDir, authority = loadOperationAuthority(config), timeoutMs = 120000, monotonicNow = () => performance.now(), fetchImpl = fetch }) {
    const startedUtc = utcNow();
    const deadlineMonotonicMs = monotonicNow() + timeoutMs;
    const results = [];
    fs.mkdirSync(path.join(stageDir, 'file-probes', 'bodies'), { recursive: true });
    for (const [originKind, base] of origins) for (const publicPath of PRODUCT_PATHS) {
        const requestedUrl = new URL(publicPath === '/' ? '/' : publicPath.slice(1), base).href;
        const requestStarted = utcNow();
        const { response, body } = await fetchProbeBytesWithinDeadline(requestedUrl, { deadlineMonotonicMs, monotonicNow, fetchImpl });
        const token = publicPath === '/' ? 'root' : publicPath.slice(1).replaceAll('/', '-').replaceAll('.', '-');
        const prefix = phase === 'initial' ? `initial-${originKind}` : 'final-alias';
        const bodyPath = `file-probes/bodies/${prefix}-${token}.bin`;
        fs.writeFileSync(path.join(stageDir, ...bodyPath.split('/')), body, { flag: 'wx' });
        const contentType = response.headers.get('content-type') ?? '';
        const result = { originKind, path: publicPath, requestedUrl, finalUrl: response.url, redirects: [], status: response.status, contentType, mime: contentType.split(';', 1)[0].trim().toLowerCase(), bodyPath, bytes: body.length, sha256: sha256Bytes(body), startedUtc: requestStarted, finishedUtc: utcNow(), transportError: null };
        validateOuterAuthority({ row: { Id: authority.deployment.deploymentId, Environment: 'Production', Branch: 'main', Source: authority.sourceGitHead.slice(0, 7), Deployment: authority.deployment.immutableUrl, Status: 'authority', Build: 'authority' }, result, authority: { deploymentId: authority.deployment.deploymentId, immutableUrl: authority.deployment.immutableUrl, sourceGitHead: authority.sourceGitHead, product: authority.productFiles[publicPath] } });
        results.push(result);
    }
    const probe = { schemaVersion: 2, phase, startedUtc, finishedUtc: utcNow(), expectedSourceGitHead: authority.sourceGitHead, expectedDeploymentId: authority.deployment.deploymentId, results, passed: results.filter(({ status }) => status === 200).length, total: results.length };
    const relative = phase === 'initial' ? 'file-probes/initial-10.json' : 'file-probes/final-alias-5.json';
    fs.writeFileSync(path.join(stageDir, ...relative.split('/')), `${canonicalJson(probe)}\n`, { flag: 'wx' });
    return { ...probe, relativePath: relative, sha256: sha256Bytes(fs.readFileSync(path.join(stageDir, ...relative.split('/')))) };
}

export async function collectInitialProbe(options) {
    return collectProbe('initial', [['immutable', options.config.immutableUrl], ['alias', options.config.aliasUrl]], options);
}

export async function collectFinalProbe(options) { return collectProbe('final-alias', [['alias', options.config.aliasUrl]], options); }

export async function collectControlPlane(phase, { config, stageDir, authority = loadOperationAuthority(config), timeoutMs = 120000, spawnImpl = spawnSync }) {
    const directory = path.join(stageDir, 'control-plane'); fs.mkdirSync(directory, { recursive: true });
    const argv = [config.nodeExePath, config.wranglerJsPath, 'pages', 'deployment', 'list', '--project-name', config.projectName, '--environment', 'production', '--json'];
    const startedUtc = utcNow();
    const result = spawnImpl(argv[0], argv.slice(1), { cwd: config.authorityProjectRoot, shell: false, encoding: null, windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL' });
    const stdout = result.stdout ?? Buffer.alloc(0), stderr = result.stderr ?? Buffer.alloc(0);
    const stdoutPath = `control-plane/${phase}.stdout.bin`, stderrPath = `control-plane/${phase}.stderr.bin`;
    fs.writeFileSync(path.join(stageDir, ...stdoutPath.split('/')), stdout, { flag: 'wx' }); fs.writeFileSync(path.join(stageDir, ...stderrPath.split('/')), stderr, { flag: 'wx' });
    const capture = { schemaVersion: 1, phase, argv, cwd: config.authorityProjectRoot, startedUtc, finishedUtc: utcNow(), exitCode: result.status ?? 2, nodeSha256: config.nodeExeSha256, wranglerSha256: config.wranglerJsSha256, stdoutPath, stdoutBytes: stdout.length, stdoutSha256: sha256Bytes(stdout), stderrPath, stderrBytes: stderr.length, stderrSha256: sha256Bytes(stderr) };
    const capturePath = `control-plane/${phase}.command.json`; fs.writeFileSync(path.join(stageDir, ...capturePath.split('/')), `${canonicalJson(capture)}\n`, { flag: 'wx' });
    if (capture.exitCode !== 0 || stderr.length !== 0) throw new Error(`worker.cloudflare.${phase}`);
    const rows = JSON.parse(stdout.toString('utf8'));
    validateWranglerRows(rows, { deploymentId: authority.deployment.deploymentId, immutableUrl: authority.deployment.immutableUrl, sourceGitHead: authority.sourceGitHead });
    validateOuterAuthority({ row: rows[0], result: { requestedUrl: config.immutableUrl, finalUrl: config.immutableUrl, status: 200, redirects: [], ...authority.productFiles['/'] }, authority: { deploymentId: authority.deployment.deploymentId, immutableUrl: authority.deployment.immutableUrl, sourceGitHead: authority.sourceGitHead, product: authority.productFiles['/'] } });
    return { phase, deploymentId: rows[0].Id, capturePath, captureSha256: sha256Bytes(fs.readFileSync(path.join(stageDir, ...capturePath.split('/')))) };
}

async function ipcExchangePhase(phase, { stageDir }) {
    if (typeof process.send !== 'function') throw new Error('worker.protocol.ipc');
    process.send({ type: `READY_${phase.toUpperCase()}`, stageDir });
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error(`worker.protocol.timeout.${phase}`)); }, 120000);
        const receive = (message) => {
            if (message?.type !== `ACK_${phase.toUpperCase()}`) return;
            cleanup();
            if (message.error) reject(new Error(`worker.protocol.${phase}: ${message.error}`));
            else resolve(message.payload);
        };
        const cleanup = () => { clearTimeout(timeout); process.off('message', receive); };
        process.on('message', receive);
    });
}

export async function runWorkerFromArgv(argv, overrides = {}) {
    const configPath = parseWorkerArgv(argv);
    const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const deps = {
        validateConfig: validateOperationConfig,
        createStageDir: defaultCreateStageDir,
        exchangePhase: ipcExchangePhase,
        runSmoke: runAcceptedSmoke,
        validateWorkerArtifacts: validateWorkerOwnedArtifacts,
        ...overrides,
    };
    const config = deps.validateConfig(rawConfig);
    if (fs.existsSync(config.acceptedDir)) throw new Error('worker.acceptedAbsent');
    const stageDir = await deps.createStageDir(config);
    const controlPlane = [];
    try {
        const initial = await deps.exchangePhase('initial', { config, stageDir });
        const initialProbe = initial.initialProbe;
        controlPlane.push(initial.controlPlane);
        const smoke = await deps.runSmoke({
            releaseId: config.releaseId, immutableUrl: config.immutableUrl, aliasUrl: config.aliasUrl,
            screenshotDir: path.join(stageDir, 'screenshots'),
            onCaseFinished: async (count) => { if (count === 3) controlPlane.push((await deps.exchangePhase('mid', { config, stageDir })).controlPlane); },
        });
        if (!controlPlane.some(({ phase }) => phase === 'mid')) controlPlane.push((await deps.exchangePhase('mid', { config, stageDir })).controlPlane);
        const post = await deps.exchangePhase('post', { config, stageDir });
        controlPlane.push(post.controlPlane);
        const finalProbe = post.finalProbe;
        deps.validateWorkerArtifacts(smoke);
        fs.writeFileSync(path.join(stageDir, 'observations.json'), `${canonicalJson(smoke.observations)}\n`, { flag: 'wx' });
        fs.writeFileSync(path.join(stageDir, 'runner-events.jsonl'), `${smoke.events.map(canonicalJson).join('\n')}\n`, { flag: 'wx' });
        let acceptedRun = { schemaVersion: 2, releaseId: config.releaseId, eventCount: smoke.events.length, caseCount: smoke.observations.length, screenshotCount: smoke.observations.flatMap(({ screenshots = [] }) => screenshots).length, initialProbe, finalProbe, controlPlane };
        if (config.deploymentRecordPath && fs.existsSync(config.deploymentRecordPath)) {
            const deployment = JSON.parse(fs.readFileSync(config.deploymentRecordPath, 'utf8'));
            const runnerRelative = 'scripts/run-public-smoke-v2.mjs';
            const libraryRelative = 'scripts/public-smoke-v2-lib.mjs';
            const playwrightAuthority = resolvePlaywrightAuthority(config.sourceSnapshotDir);
            const tool = (relative, version) => ({ path: relative, version, sha256: sha256Bytes(fs.readFileSync(path.join(config.sourceSnapshotDir, ...relative.split('/')))) });
            acceptedRun = {
                schemaVersion: 2, releaseId: config.releaseId, campaignRunId: config.campaignRunId, sourceGitHead: deployment.sourceGitHead,
                deploymentId: deployment.deploymentId, immutableUrl: config.immutableUrl, aliasUrl: config.aliasUrl,
                startedUtc: smoke.observations[0].startedUtc, finishedUtc: smoke.observations.at(-1).finishedUtc,
                startedMonotonicMs: smoke.observations[0].startedMonotonicMs, finishedMonotonicMs: smoke.observations.at(-1).finishedMonotonicMs,
                engines: ['chromium', 'firefox', 'webkit'], originKinds: ['immutable', 'alias'], attemptsPerCase: 1, retries: 0, skips: 0,
                caseLabels: expectedCaseLabels(), observationsPath: 'observations.json', eventsPath: 'runner-events.jsonl', screenshotCount: 18,
                productFiles: deployment.productFiles,
                tooling: { runner: tool(runnerRelative, '2'), library: tool(libraryRelative, '2'), playwright: { path: playwrightAuthority.path, version: playwrightAuthority.version, sha256: playwrightAuthority.sha256 } },
            };
        }
        fs.writeFileSync(path.join(stageDir, 'accepted-run.json'), `${canonicalJson(acceptedRun)}\n`, { flag: 'wx' });
        const manifest = await publishAcceptedStage({ stageDir, acceptedDir: config.acceptedDir, releaseId: config.releaseId });
        return { eventCount: smoke.events.length, observations: smoke.observations, controlPlane, initialProbe, finalProbe, manifest };
    } catch (error) {
        if (fs.existsSync(stageDir)) await publishFailureStage({ stageDir, failureRoot: config.failureRoot ?? path.dirname(stageDir), basicUtc: utcNow().replaceAll(/[-:.]/g, '') });
        throw error;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runWorkerFromArgv(process.argv.slice(2)).catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
