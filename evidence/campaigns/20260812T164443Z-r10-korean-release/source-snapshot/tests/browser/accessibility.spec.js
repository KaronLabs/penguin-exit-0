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

    for (let index = 0; index < 2; index += 1) await produce.click();
    await inspect('upgrades available');
    await page.locator('.upgrade-card button').first().click();
    await inspect('upgrade owned');

    const intrusions = new Set();
    for (let step = 0; step < 60; step += 1) {
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
        if (state.units === 200 && state.stars < 3000) await inspect('RECOVER');
        await produce.click();
    }
    expect(intrusions.size).toBe(4);
    await inspect('ending');
}

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
    expect(await page.locator('#ending-overlay').evaluate((overlay) => getComputedStyle(overlay).position)).toBe('fixed');
    const h1LineCount = await page.locator('h1').evaluate((heading) => {
        const style = getComputedStyle(heading);
        const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
        return Math.round(heading.getBoundingClientRect().height / lineHeight);
    });
    expect(h1LineCount).toBe(1);
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
});

test('탭 클릭은 active와 aria-selected를 동기화한다', async ({ page }) => {
    await page.goto('/');

    for (const tabId of ['wifi', 'cpu', 'ssh']) {
        const tab = page.locator(`[data-puz="${tabId}"]`);
        await tab.click();
        expect(await tab.getAttribute('class')).toContain('active');
        expect(await tab.getAttribute('aria-selected')).toBe('true');
        expect(await page.locator(`[role="tab"]:not([data-puz="${tabId}"])`).evaluateAll((tabs) => tabs.every((other) => other.getAttribute('aria-selected') === 'false'))).toBe(true);
    }
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
