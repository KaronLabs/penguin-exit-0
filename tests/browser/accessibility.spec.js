import { test, expect } from '@playwright/test';

const interactiveSelector = 'button:not([hidden]), a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"]';
const minimumTouchTarget = 47.99;

async function inspectVisibleInteractives(page) {
    return page.locator(interactiveSelector).evaluateAll((elements) => elements
        .filter((element) => {
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        })
        .map((element) => {
            const rect = element.getBoundingClientRect();
            return { label: element.getAttribute('aria-label') || element.textContent.trim(), width: rect.width, height: rect.height };
        }));
}

async function metrics(page) {
    return page.evaluate(() => ({
        units: Number.parseInt(document.querySelector('#val-units').textContent, 10),
        stars: Number.parseInt(document.querySelector('#val-stars').textContent, 10)
    }));
}

function durationMs(token) {
    const value = Number.parseFloat(token) || 0;
    return token.trim().endsWith('ms') ? value : value * 1000;
}

async function visitRepresentativeStates(page, inspect) {
    const produce = page.locator('#btn-produce');
    const banner = page.locator('#intrusion-banner');
    await inspect('initial');
    await page.locator('[data-puz="ssh"]').click();
    const options = page.locator('.puzzle-option');
    const optionTexts = await options.allTextContents();
    const longestIndex = optionTexts.reduce((winner, text, index) => text.length > optionTexts[winner].length ? index : winner, 0);
    await options.nth(longestIndex).click();
    await inspect('longest puzzle choice');
    await expect(page.locator('#dangerous-alliance-overlay')).toBeVisible();
    await inspect('dangerous alliance');
    await page.locator('#btn-accept-alliance-result').click();

    for (let index = 0; index < 2; index += 1) await produce.click();
    await inspect('upgrades available');
    await page.locator('.upgrade-card button').first().click();
    await inspect('upgrade owned');

    const intrusions = new Set();
    for (let step = 0; step < 100; step += 1) {
        if (await banner.isVisible()) {
            const title = await page.locator('#intrusion-title').innerText();
            intrusions.add(title);
            await inspect(`intrusion ${title}`);
            if (await page.locator('#btn-ceo-ship').isVisible()) await page.locator('#btn-revert').click();
            else await page.keyboard.press('Escape');
            continue;
        }
        const state = await metrics(page);
        if (await page.locator('#ending-overlay').isVisible()) break;
        if (state.units === 200 && state.stars < 9000) await inspect('RECOVER');
        await produce.click();
    }
    expect(intrusions.size).toBe(4);
    await inspect('ending');
}

async function openDangerousAlliance(page) {
    await page.locator('[data-puz="ssh"]').click();
    const trigger = page.locator('.puzzle-option').nth(1);
    await trigger.click();
    await expect(page.locator('#dangerous-alliance-overlay')).toBeVisible();
    return trigger;
}

test('위험 동맹 팝업은 포커스를 가두고 Escape와 확인 버튼 뒤 정확한 선택지로 복원한다', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    let trigger = await openDangerousAlliance(page);
    const closeButton = page.locator('#btn-accept-alliance-result');
    const background = page.locator('body > header, body > .dashboard, body > #intrusion-banner, body > .main-grid');

    await expect(closeButton).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(closeButton).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(closeButton).toBeFocused();
    expect(await background.evaluateAll((elements) => elements.map((element) => element.inert))).toEqual([true, true, true, true]);

    await page.keyboard.press('Escape');
    await expect(page.locator('#dangerous-alliance-overlay')).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(await background.evaluateAll((elements) => elements.map((element) => element.inert))).toEqual([false, false, false, false]);

    await page.reload();
    trigger = await openDangerousAlliance(page);
    await page.locator('#btn-accept-alliance-result').click();
    await expect(page.locator('#dangerous-alliance-overlay')).toBeHidden();
    await expect(trigger).toBeFocused();
});

test('위험 동맹 Escape는 활성 침입보다 먼저 팝업만 닫는다', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    for (let click = 0; click < 5; click += 1) await page.locator('#btn-produce').click();
    await expect(page.locator('#intrusion-banner')).toBeVisible();
    const trigger = await openDangerousAlliance(page);

    await page.keyboard.press('Escape');
    await expect(page.locator('#dangerous-alliance-overlay')).toBeHidden();
    await expect(page.locator('#intrusion-banner')).toBeVisible();
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('#intrusion-banner')).toBeHidden();
});

test('게임 초기화는 열린 위험 동맹과 예약된 결과 타이머를 함께 정리한다', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await openDangerousAlliance(page);
    await page.evaluate(() => window.__resetGameForTest());
    await expect(page.locator('#dangerous-alliance-overlay')).toBeHidden();
    expect(await page.locator('body > header, body > .dashboard, body > #intrusion-banner, body > .main-grid').evaluateAll((elements) => elements.every((element) => !element.inert))).toBe(true);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('[data-puz="ssh"]').click();
    await page.locator('.puzzle-option').nth(1).click();
    await page.evaluate(() => window.__resetGameForTest());
    await page.waitForTimeout(1100);
    await expect(page.locator('#dangerous-alliance-overlay')).toBeHidden();
    await expect(page.locator('#terminal-output')).toBeEmpty();
    await expect(page.locator('#val-tuna')).toHaveText('0 / 3');
    await expect(page.locator('#val-debt')).toHaveText('0%');
});

test('위험 동맹 팝업은 동작 감소에서 정지하고 세 필수 뷰포트에서 도달 가능하다', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const viewport of [
        { width: 320, height: 640 },
        { width: 640, height: 360 },
        { width: 1280, height: 720 }
    ]) {
        await page.setViewportSize(viewport);
        await page.goto('/');
        await openDangerousAlliance(page);
        const overlay = page.locator('#dangerous-alliance-overlay');
        const dialog = page.locator('.dangerous-alliance-dialog');
        const closeButton = page.locator('#btn-accept-alliance-result');
        const motion = await dialog.evaluate((element) => {
            const style = getComputedStyle(element);
            return { animationName: style.animationName, transitionDuration: style.transitionDuration };
        });
        expect(motion).toEqual({ animationName: 'none', transitionDuration: '0s' });
        expect(await overlay.evaluate((element) => getComputedStyle(element).position)).toBe('fixed');
        const dialogBox = await dialog.boundingBox();
        expect(dialogBox.width).toBeGreaterThan(0);
        expect(dialogBox.height).toBeGreaterThan(0);
        expect(dialogBox.x).toBeLessThan(viewport.width);
        expect(dialogBox.x + dialogBox.width).toBeGreaterThan(0);
        expect(dialogBox.y).toBeLessThan(viewport.height);
        expect(dialogBox.y + dialogBox.height).toBeGreaterThan(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
        await closeButton.scrollIntoViewIfNeeded();
        const closeBox = await closeButton.boundingBox();
        expect(closeBox.x).toBeGreaterThanOrEqual(0);
        expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(viewport.width);
        expect(closeBox.y).toBeGreaterThanOrEqual(0);
        expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(viewport.height);
        await expect(closeButton).toBeVisible();
    }
});

test('320x640에서 대표 상태에 가로 오버플로가 없고 터치 타깃이 48x48 이상이다', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/');
    if (process.env.ACCESSIBILITY_MUTATION === 'ending-absolute-320') {
        await page.addStyleTag({ content: '@media (max-width: 320px) { #ending-overlay { position: absolute !important; } }' });
    }

    const snapshots = [];
    await visitRepresentativeStates(page, async (name) => {
        snapshots.push({ name, targets: await inspectVisibleInteractives(page), scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth) });
    });
    await page.evaluate(() => window.__resetGameForTest());
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('[data-puz="wifi"]').click();
    await page.locator('.puzzle-option').first().click();
    for (let click = 0; click < 30; click += 1) await page.locator('.puzzle-option').first().click();
    await expect(page.locator('#terminal-output [data-dialogue-context="repeat"]')).toHaveCount(27);
    if (process.env.ACCESSIBILITY_MUTATION === 'npc-overlap-320') {
        await page.addStyleTag({ content: '#npc-card { transform: translateY(-280px) !important; }' });
    }
    await page.locator('[data-puz="cpu"]').click();
    await page.locator('.puzzle-option').first().click();
    const npc = page.locator('#npc-card');
    await expect(npc).toBeVisible();
    await expect(npc).toHaveText(/Walrus DBA/);
    if (process.env.ACCESSIBILITY_MUTATION === 'npc-quote-overlap-320') {
        await page.addStyleTag({ content: '#quote-collection { position: relative; top: -35px; }' });
    }
    await page.evaluate(() => {
        const userStyle = document.createElement('style');
        userStyle.textContent = '#terminal-output { letter-spacing: 0.12em !important; word-spacing: 0.16em !important; line-height: 1.5 !important; }';
        document.head.append(userStyle);
    });
    await expect.poll(() => page.locator('#terminal-output').evaluate((terminal) => getComputedStyle(terminal).letterSpacing)).not.toBe('normal');
    expect(await page.locator('#ending-overlay').evaluate((overlay) => getComputedStyle(overlay).position)).toBe('fixed');
    const h1LineCount = await page.locator('h1').evaluate((heading) => {
        const style = getComputedStyle(heading);
        const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
        return Math.round(heading.getBoundingClientRect().height / lineHeight);
    });
    expect(h1LineCount).toBe(1);
    const terminalLayout = await page.locator('#terminal-output').evaluate((terminal) => ({
        height: terminal.getBoundingClientRect().height,
        rootScrollWidth: document.documentElement.scrollWidth,
        scrollWidth: terminal.scrollWidth,
        clientWidth: terminal.clientWidth
    }));
    expect(terminalLayout.height).toBe(240);
    expect(terminalLayout.rootScrollWidth).toBeLessThanOrEqual(320);
    expect(terminalLayout.scrollWidth).toBeLessThanOrEqual(terminalLayout.clientWidth);
    const textSpacingLayout = await page.evaluate(() => {
        const terminal = document.querySelector('#terminal-output');
        const npc = document.querySelector('#npc-card');
        const quotes = document.querySelector('#quote-collection');
        const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const terminalRect = terminal.getBoundingClientRect();
        const npcRect = npc.getBoundingClientRect();
        const quoteRect = quotes.getBoundingClientRect();
        const intersectionArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        return {
            letterSpacing: getComputedStyle(terminal).letterSpacing,
            wordSpacing: getComputedStyle(terminal).wordSpacing,
            lineHeight: getComputedStyle(terminal).lineHeight,
            terminalRight: terminalRect.right,
            viewportRight: window.innerWidth,
            npcWidth: npcRect.width,
            npcHeight: npcRect.height,
            npcIntersectionArea: intersectionArea(terminalRect, npcRect),
            npcQuoteIntersectionArea: intersectionArea(npcRect, quoteRect),
            quoteOverlap: overlaps(terminalRect, quoteRect),
            rootScrollWidth: document.documentElement.scrollWidth
        };
    });
    expect(textSpacingLayout.letterSpacing).not.toBe('normal');
    expect(textSpacingLayout.wordSpacing).not.toBe('0px');
    expect(textSpacingLayout.lineHeight).not.toBe('normal');
    expect(textSpacingLayout.terminalRight).toBeLessThanOrEqual(textSpacingLayout.viewportRight);
    expect(textSpacingLayout.rootScrollWidth).toBeLessThanOrEqual(320);
    expect(textSpacingLayout.npcWidth).toBeGreaterThan(0);
    expect(textSpacingLayout.npcHeight).toBeGreaterThan(0);
    expect(textSpacingLayout.npcIntersectionArea).toBe(0);
    expect(textSpacingLayout.npcQuoteIntersectionArea).toBe(0);
    expect(textSpacingLayout.quoteOverlap).toBe(false);

    const terminal = page.locator('#terminal-output');
    await page.locator('.puzzle-option').last().focus();
    await page.keyboard.press('Tab');
    await expect(terminal).toBeFocused();
    await expect(terminal).toHaveCSS('outline-style', 'solid');
    await expect(terminal).toHaveCSS('outline-width', '2px');
    await expect(terminal).toHaveCSS('outline-color', 'rgb(84, 199, 236)');
    const scrollTopBeforePageUp = await terminal.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
        return node.scrollTop;
    });
    expect(scrollTopBeforePageUp).toBeGreaterThan(0);
    await page.keyboard.press('PageUp');
    await expect.poll(() => terminal.evaluate((node) => node.scrollTop)).toBeLessThan(scrollTopBeforePageUp);
    await page.evaluate(() => window.__resetGameForTest());
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    for (const snapshot of snapshots) {
        expect(snapshot.scrollWidth, `${snapshot.name} horizontal overflow`).toBeLessThanOrEqual(320);
        for (const target of snapshot.targets) {
            expect(target.width, `${snapshot.name}: ${target.label} width`).toBeGreaterThanOrEqual(minimumTouchTarget);
            expect(target.height, `${snapshot.name}: ${target.label} height`).toBeGreaterThanOrEqual(minimumTouchTarget);
        }
    }
    await page.evaluate(() => window.__resetGameForTest());
    const produce = page.locator('#btn-produce');
    for (const type of ['copilot', 'codex', 'gemini']) {
        for (let click = 0; click < 5; click += 1) await produce.click();
        await expect(page.locator('body')).toHaveClass(new RegExp(`intrusion-impact--${type}`));
        await page.evaluate(() => document.querySelector('#btn-revert').click());
    }
    for (let click = 0; click < 4; click += 1) await produce.click();
    const activationFocus = await page.evaluate(() => {
        const button = document.querySelector('#btn-produce');
        const focusTarget = document.querySelector('[data-puz="wifi"]');
        focusTarget.focus();
        const before = document.activeElement.getAttribute('data-puz');
        button.click();
        return { before, during: document.activeElement.getAttribute('data-puz'), active: document.body.classList.contains('intrusion-impact--ceo') };
    });
    expect(activationFocus).toEqual({ before: 'wifi', during: 'wifi', active: true });
    const impactSample = await page.evaluate(async () => {
        const startedAt = performance.now();
        let max = 0;
        let focusStable = true;
        while (performance.now() - startedAt < 560) {
            await new Promise(requestAnimationFrame);
            max = Math.max(max, document.documentElement.scrollWidth);
            focusStable &&= document.activeElement.getAttribute('data-puz') === 'wifi';
        }
        return { max, focusStable };
    });
    expect(impactSample.max).toBeLessThanOrEqual(320);
    expect(impactSample.focusStable).toBe(true);
    await page.keyboard.press('Escape');
    await expect(produce).toBeFocused();
});

test('640x360 reflow에서 핵심 동작과 엔딩이 스크롤로 도달 가능하다', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 360 });
    await page.goto('/');

    expect(await page.locator('#terminal-output').evaluate((terminal) => terminal.getBoundingClientRect().height)).toBe(160);

    await visitRepresentativeStates(page, async () => {});
    const ending = page.locator('#ending-overlay > div');
    const replay = ending.getByRole('button');
    await replay.scrollIntoViewIfNeeded();
    const layout = await ending.evaluate((dialog) => ({
        scrollHeight: dialog.scrollHeight,
        clientHeight: dialog.clientHeight,
        maxHeight: getComputedStyle(dialog).maxHeight,
        overflowY: getComputedStyle(dialog).overflowY,
        rootScrollWidth: document.documentElement.scrollWidth
    }));
    expect(layout.rootScrollWidth).toBeLessThanOrEqual(640);
    expect(['auto', 'scroll']).toContain(layout.overflowY);
    expect(layout.maxHeight).not.toBe('none');
    expect(await page.locator('#ending-overlay').evaluate((overlay) => getComputedStyle(overlay).position)).toBe('fixed');
    if (layout.scrollHeight > layout.clientHeight) expect(layout.clientHeight).toBeGreaterThan(0);
    expect(await replay.isVisible()).toBe(true);

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.reload();
    expect(await page.locator('#terminal-output').evaluate((terminal) => terminal.getBoundingClientRect().height)).toBe(224);
    await page.setViewportSize({ width: 1100, height: 960 });
    expect(await page.locator('#terminal-output').evaluate((terminal) => terminal.getBoundingClientRect().height)).toBe(288);
});

test('탭은 클릭과 키보드 조작에서 선택 상태와 패널 연결을 동기화한다', async ({ page }) => {
    await page.goto('/');

    const panel = page.locator('#puzzle-panel');
    const tablist = page.getByRole('tablist');
    const wifi = page.locator('[data-puz="wifi"]');
    const cpu = page.locator('[data-puz="cpu"]');
    const ssh = page.locator('[data-puz="ssh"]');
    await expect(tablist).toHaveAccessibleName('장애 진단 터미널');
    await expect(panel).toHaveAttribute('role', 'tabpanel');
    await expect(wifi).toHaveAttribute('aria-selected', 'true');
    await expect(wifi).toHaveAttribute('tabindex', '0');
    await expect(cpu).toHaveAttribute('aria-selected', 'false');
    await expect(cpu).toHaveAttribute('tabindex', '-1');
    await expect(ssh).toHaveAttribute('aria-selected', 'false');
    await expect(ssh).toHaveAttribute('tabindex', '-1');
    await expect(panel).toHaveAttribute('aria-labelledby', 'tab-wifi');
    for (const tabId of ['wifi', 'cpu', 'ssh']) {
        const tab = page.locator(`[data-puz="${tabId}"]`);
        await expect(tab).toHaveAttribute('id', `tab-${tabId}`);
        await expect(tab).toHaveAttribute('aria-controls', 'puzzle-panel');
        await tab.click();
        expect(await tab.getAttribute('class')).toContain('active');
        expect(await tab.getAttribute('aria-selected')).toBe('true');
        await expect(tab).toHaveAttribute('tabindex', '0');
        await expect(panel).toHaveAttribute('aria-labelledby', `tab-${tabId}`);
        expect(await page.locator(`[role="tab"]:not([data-puz="${tabId}"])`).evaluateAll((tabs) => tabs.every((other) => other.getAttribute('aria-selected') === 'false'))).toBe(true);
        expect(await page.locator(`[role="tab"]:not([data-puz="${tabId}"])`).evaluateAll((tabs) => tabs.every((other) => other.getAttribute('tabindex') === '-1'))).toBe(true);
    }

    await wifi.focus();
    await page.keyboard.press('ArrowRight');
    await expect(cpu).toBeFocused();
    await expect(cpu).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#puzzle-title')).toHaveText('장애 #2: 서버 #4 고CPU 경보');
    await page.keyboard.press('End');
    await expect(ssh).toBeFocused();
    await page.keyboard.press('Home');
    await expect(wifi).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(ssh).toBeFocused();
    await expect(panel).toHaveAttribute('aria-labelledby', 'tab-ssh');
    await expect(page.locator('#puzzle-title')).toHaveText('장애 #3: 골든 티켓 SSH 침입');
});

test('reduced-motion은 transition을 제거하면서 게임 조작을 보존한다', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');

    const durations = await page.locator('*').evaluateAll((elements) => elements.map((element) => {
        const style = getComputedStyle(element);
        return { transition: style.transitionDuration, animation: style.animationDuration };
    }));
    for (const duration of durations) {
        for (const value of [duration.transition, duration.animation]) {
            for (const part of value.split(', ')) {
                expect(durationMs(part)).toBeLessThanOrEqual(1);
            }
        }
    }
    await page.locator('#btn-produce').click();
    expect(await page.locator('#val-units').innerText()).not.toBe('0 / 200');
    for (let click = 0; click < 4; click += 1) await page.locator('#btn-produce').click();
    await expect(page.locator('#intrusion-banner')).toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/intrusion-impact--/);
    const impactStyles = await page.locator('body > header, body > .dashboard, body > .intrusion-banner, body > .main-grid').evaluateAll((targets) => targets.map((target) => {
        const style = getComputedStyle(target);
        return { animation: style.animationName, transform: style.transform, willChange: style.willChange };
    }));
    for (const style of impactStyles) {
        expect(style.animation).toBe('none');
        expect(style.transform).toBe('none');
        expect(style.willChange).toBe('auto');
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(700);
    await expect(page.locator('body')).not.toHaveClass(/intrusion-impact--/);
    await page.locator('[data-puz="cpu"]').click();
    expect(await page.locator('[data-puz="cpu"]').getAttribute('class')).toContain('active');
});
