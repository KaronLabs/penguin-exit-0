import { test, expect } from '@playwright/test';

const impactTypes = [
    { type: 'copilot', duration: 320, x: 3, y: 0 },
    { type: 'codex', duration: 420, x: 4, y: 1 },
    { type: 'gemini', duration: 650, x: 2, y: 0 },
    { type: 'ceo', duration: 520, x: 5, y: 1 }
];
const impactSelector = 'body > header, body > .dashboard, body > .intrusion-banner, body > .main-grid';

async function observeImpactStarts(page) {
    await page.evaluate(() => {
        const types = ['copilot', 'codex', 'gemini', 'ceo'];
        window.__intrusionImpactStarts = [];
        let previous = '';
        new MutationObserver(() => {
            const current = types.find((type) => document.body.classList.contains(`intrusion-impact--${type}`)) || '';
            if (current && current !== previous) window.__intrusionImpactStarts.push(current);
            previous = current;
        }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    });
}

async function produceUntilIntrusion(page, type) {
    const produce = page.locator('#btn-produce');
    const banner = page.locator('#intrusion-banner');
    for (let click = 0; click < 5; click += 1) {
        await produce.click();
        if (await banner.isVisible()) break;
    }
    await expect(banner).toBeVisible();
    await expect(page.locator('body')).toHaveClass(new RegExp(`intrusion-impact--${type}`));
}

async function inspectImpact(page, type, browserName) {
    return page.evaluate(({ selector, type: expectedType, verifyMatrix }) => {
        const targets = [...document.querySelectorAll(selector)];
        return {
            activeTypes: ['copilot', 'codex', 'gemini', 'ceo'].filter((type) => document.body.classList.contains(`intrusion-impact--${type}`)),
            bodyTransform: getComputedStyle(document.body).transform,
            endingTransform: getComputedStyle(document.querySelector('#ending-overlay')).transform,
            targets: targets.map((target) => {
                const animation = target.getAnimations().find((candidate) => candidate.animationName === `intrusion-impact-${expectedType}`);
                if (!animation) return null;
                const timing = animation.effect.getTiming();
                return {
                    duration: timing.duration,
                    iterations: timing.iterations,
                    fill: timing.fill,
                    easing: timing.easing,
                    keyframes: verifyMatrix ? animation.effect.getKeyframes().map((frame) => {
                        const matrix = new DOMMatrixReadOnly(frame.transform === 'none' ? undefined : frame.transform);
                        return { x: matrix.m41, y: matrix.m42 };
                    }) : []
                };
            })
        };
    }, { selector: impactSelector, type, verifyMatrix: browserName === 'chromium' });
}

async function expectImpact(page, spec, browserName) {
    const snapshot = await inspectImpact(page, spec.type, browserName);
    expect(snapshot.activeTypes).toEqual([spec.type]);
    expect(snapshot.bodyTransform).toBe('none');
    expect(snapshot.endingTransform).toBe('none');
    expect(snapshot.targets).toHaveLength(4);
    for (const animation of snapshot.targets) {
        expect(animation).not.toBeNull();
        expect(animation.duration).toBe(spec.duration);
        expect(animation.iterations).toBe(1);
        expect(animation.fill).toBe('both');
        expect(animation.easing).toBe('linear');
        if (browserName === 'chromium') {
            const xValues = animation.keyframes.map((frame) => frame.x);
            const yValues = animation.keyframes.map((frame) => frame.y);
            expect(animation.keyframes.at(-1)).toEqual({ x: 0, y: 0 });
            expect(Math.max(...xValues)).toBeGreaterThanOrEqual(spec.x);
            expect(Math.min(...xValues)).toBeLessThanOrEqual(-spec.x);
            expect(Math.max(...yValues.map(Math.abs))).toBeGreaterThanOrEqual(spec.y);
        }
    }
    if (browserName === 'chromium' && spec.type === 'gemini') {
        expect(snapshot.targets[0].keyframes.filter((frame) => Math.abs(frame.x) === 2).length).toBeGreaterThanOrEqual(6);
    }
}

async function impactStarts(page) {
    return page.evaluate(() => [...window.__intrusionImpactStarts]);
}

test('AI Intrusion Mechanics - Gemini 3s Auto-resolve Timer', async ({ page, browserName }) => {
    await page.goto('/');
    await observeImpactStarts(page);

    const btnProduce = page.locator('#btn-produce');
    const banner = page.locator('#intrusion-banner');
    const title = page.locator('#intrusion-title');
    const message = page.locator('#intrusion-msg');

    await produceUntilIntrusion(page, 'copilot');
    await expectImpact(page, impactTypes[0], browserName);
    await page.locator('.upgrade-card button').first().click();
    expect(await impactStarts(page)).toEqual(['copilot']);
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/intrusion-impact--/);

    await produceUntilIntrusion(page, 'codex');
    await expectImpact(page, impactTypes[1], browserName);
    await page.locator('.puzzle-option').first().click();
    await expect(page.locator('body')).not.toHaveClass(/intrusion-impact--/);
    await page.keyboard.press('Escape');

    await produceUntilIntrusion(page, 'gemini');
    await expectImpact(page, impactTypes[2], browserName);

    // Verify Gemini intrusion banner and disabled produce button
    await expect(banner).toBeVisible();
    await expect(title).toHaveText('✨ Gemini 응답 지연!');
    await expect(message).toHaveText('Gemini가 응답을 생성 중입니다... 3초 후 자동 해제되며 Esc로도 해제할 수 있습니다.');
    await expect(btnProduce).toBeDisabled();
    await expect(btnProduce).toHaveText('AI 침입 진행 중 — Esc로 롤백');

    const activatedAt = await page.evaluate(() => performance.now());
    await page.waitForTimeout(2300);
    await expect(banner).toBeVisible();
    await expect(banner).toBeHidden({ timeout: 3000 });
    const resolvedAfterMs = await page.evaluate((startedAt) => performance.now() - startedAt, activatedAt);
    expect(resolvedAfterMs).toBeGreaterThanOrEqual(2700);
    expect(resolvedAfterMs).toBeLessThanOrEqual(5000);
    await expect(btnProduce).toBeEnabled();
    await expect(page.locator('body')).not.toHaveClass(/intrusion-impact--/);

    await produceUntilIntrusion(page, 'ceo');
    await expectImpact(page, impactTypes[3], browserName);
    await page.locator('#btn-ceo-ship').click();
    await expect(page.locator('#ending-overlay')).toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/intrusion-impact--/);
    expect(await impactStarts(page)).toEqual(['copilot', 'codex', 'gemini', 'ceo']);
});

test('AI Intrusion Mechanics - CEO Order Reject (-500★ & +$500 cost)', async ({ page }) => {
    await page.goto('/');
    await observeImpactStarts(page);

    const btnProduce = page.locator('#btn-produce');
    const valStars = page.locator('#val-stars');
    const valCost = page.locator('#val-cost');
    const banner = page.locator('#intrusion-banner');
    const title = page.locator('#intrusion-title');

    for (const type of ['copilot', 'codex', 'gemini']) {
        await produceUntilIntrusion(page, type);
        await page.keyboard.press('Escape');
    }
    await produceUntilIntrusion(page, 'ceo');
    await expect(banner).toBeVisible();
    await expect(title).toHaveText('💼 CEO 금요일 17:59 배포 지시!');
    await expect(page.locator('#btn-ceo-ship')).toBeVisible();

    const starsBefore = parseInt((await valStars.innerText()).replace(/[^0-9]/g, ''), 10);
    const costBefore = parseInt((await valCost.innerText()).replace(/[^0-9]/g, ''), 10);

    // Click Reject button
    await page.locator('#btn-revert').click();

    const starsAfter = parseInt((await valStars.innerText()).replace(/[^0-9]/g, ''), 10);
    const costAfter = parseInt((await valCost.innerText()).replace(/[^0-9]/g, ''), 10);

    expect(starsBefore - starsAfter).toBe(500);
    expect(costAfter - costBefore).toBe(500);
    await expect(banner).toBeHidden();
    await expect(btnProduce).toBeEnabled();
    await expect(page.locator('body')).not.toHaveClass(/intrusion-impact--/);

    await page.evaluate(() => window.__resetGameForTest());
    await produceUntilIntrusion(page, 'copilot');
    await page.evaluate(() => window.__resetGameForTest());
    await expect(page.locator('body')).not.toHaveClass(/intrusion-impact--/);
    expect(await impactStarts(page)).toEqual(['copilot', 'codex', 'gemini', 'ceo', 'copilot']);
});
