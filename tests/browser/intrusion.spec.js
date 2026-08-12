import { test, expect } from '@playwright/test';

const impactTypes = [
    { type: 'copilot', duration: 320, frames: [[0, 0, 0], [0.25, 3, 0], [0.5, -3, 0], [0.75, 3, 0], [1, 0, 0]] },
    { type: 'codex', duration: 420, frames: [[0, 0, 0], [0.25, 4, 1], [0.5, -4, -1], [0.75, 4, 1], [1, 0, 0]] },
    { type: 'gemini', duration: 650, frames: [[0, 0, 0], [0.15, 2, 0], [0.25, 2, 0], [0.35, -2, 0], [0.45, 2, 0], [0.55, 2, 0], [0.65, -2, 0], [0.75, 2, 0], [0.85, 2, 0], [1, 0, 0]] },
    { type: 'ceo', duration: 520, frames: [[0, 0, 0], [0.25, 5, 1], [0.5, -5, -1], [0.75, 5, 1], [1, 0, 0]] }
];
const impactSelector = 'body > header, body > .dashboard, body > .intrusion-banner, body > .main-grid';
const controlledMutation = process.env.INTRUSION_MUTATION || '';

async function observeImpact(page) {
    await page.evaluate(() => {
        const types = ['copilot', 'codex', 'gemini', 'ceo'];
        const names = new Set(types.map((type) => `intrusion-impact-${type}`));
        const banner = document.querySelector('#intrusion-banner');
        window.__intrusionImpactClassTransitions = [];
        window.__intrusionAnimationStarts = [];
        window.__intrusionAnimationIds = new WeakMap();
        window.__nextIntrusionAnimationId = 1;
        let previous = '';
        new MutationObserver(() => {
            const current = types.find((type) => document.body.classList.contains(`intrusion-impact--${type}`)) || '';
            if (current && current !== previous) window.__intrusionImpactClassTransitions.push(current);
            previous = current;
        }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
        banner.addEventListener('animationstart', (event) => {
            if (event.target === banner && names.has(event.animationName)) window.__intrusionAnimationStarts.push(event.animationName);
        });
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
    await expect.poll(() => page.evaluate(() => window.__intrusionAnimationStarts.at(-1))).toBe(`intrusion-impact-${type}`);
}

async function inspectImpact(page, type, browserName) {
    return page.evaluate(({ selector, expectedType, verifyMatrix }) => {
        const targets = [...document.querySelectorAll(selector)];
        return {
            activeTypes: ['copilot', 'codex', 'gemini', 'ceo'].filter((type) => document.body.classList.contains(`intrusion-impact--${type}`)),
            bodyTransform: getComputedStyle(document.body).transform,
            endingTransform: getComputedStyle(document.querySelector('#ending-overlay')).transform,
            targets: targets.map((target) => {
                const animation = target.getAnimations().find((candidate) => candidate.animationName === `intrusion-impact-${expectedType}`);
                if (!animation) return null;
                let identity = window.__intrusionAnimationIds.get(animation);
                if (!identity) {
                    identity = window.__nextIntrusionAnimationId;
                    window.__nextIntrusionAnimationId += 1;
                    window.__intrusionAnimationIds.set(animation, identity);
                }
                const timing = animation.effect.getTiming();
                return {
                    identity,
                    startTime: animation.startTime,
                    duration: timing.duration,
                    iterations: timing.iterations,
                    fill: timing.fill,
                    easing: timing.easing,
                    keyframes: verifyMatrix ? animation.effect.getKeyframes().map((frame) => {
                        const matrix = new DOMMatrixReadOnly(frame.transform === 'none' ? undefined : frame.transform);
                        return { offset: frame.offset, x: matrix.m41, y: matrix.m42 };
                    }) : []
                };
            })
        };
    }, { selector: impactSelector, expectedType: type, verifyMatrix: browserName === 'chromium' });
}

function expectApproximateFrames(actual, expected) {
    expect(actual).toHaveLength(expected.length);
    for (let index = 0; index < expected.length; index += 1) {
        const [offset, x, y] = expected[index];
        expect(actual[index].offset).toBeCloseTo(offset, 6);
        expect(actual[index].x).toBeCloseTo(x, 6);
        expect(actual[index].y).toBeCloseTo(y, 6);
    }
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
            expectApproximateFrames(animation.keyframes, spec.frames);
            const xValues = animation.keyframes.map((frame) => frame.x);
            const yValues = animation.keyframes.map((frame) => frame.y);
            const expectedX = spec.frames.map((frame) => frame[1]);
            const expectedY = spec.frames.map((frame) => frame[2]);
            expect(Math.max(...xValues)).toBeCloseTo(Math.max(...expectedX), 6);
            expect(Math.min(...xValues)).toBeCloseTo(Math.min(...expectedX), 6);
            expect(Math.max(...yValues)).toBeCloseTo(Math.max(...expectedY), 6);
            expect(Math.min(...yValues)).toBeCloseTo(Math.min(...expectedY), 6);
            if (Math.max(...expectedY) === 0 && Math.min(...expectedY) === 0) expect(yValues.every((value) => value === 0)).toBe(true);
        }
    }
    if (browserName === 'chromium' && spec.type === 'gemini') {
        const frames = snapshot.targets[0].keyframes;
        for (const [first, second] of [[1, 2], [4, 5], [7, 8]]) {
            expect(frames[first].offset).toBeLessThan(frames[second].offset);
            expect(frames[first].x).toBe(frames[second].x);
            expect(frames[first].y).toBe(frames[second].y);
        }
    }
    return snapshot;
}

async function expectNaturalCleanup(page, spec) {
    await page.waitForTimeout(spec.duration + 120);
    await expect(page.locator('body')).not.toHaveClass(/intrusion-impact--/);
}

async function animationStarts(page) {
    return page.evaluate(() => [...window.__intrusionAnimationStarts]);
}

async function impactClassTransitions(page) {
    return page.evaluate(() => [...window.__intrusionImpactClassTransitions]);
}

async function blockImpactRemoval(page, mutationName) {
    if (controlledMutation !== mutationName) return;
    await page.evaluate(() => {
        window.__originalImpactRemove = DOMTokenList.prototype.remove;
        DOMTokenList.prototype.remove = function(...tokens) {
            if (this === document.body.classList && tokens.some((token) => token.startsWith('intrusion-impact--'))) return;
            return window.__originalImpactRemove.apply(this, tokens);
        };
    });
}

async function restoreImpactRemoval(page, mutationName) {
    if (controlledMutation !== mutationName) return;
    await page.evaluate(() => {
        DOMTokenList.prototype.remove = window.__originalImpactRemove;
        delete window.__originalImpactRemove;
    });
}

async function resolveCurrentIntrusion(page) {
    await page.evaluate(() => document.querySelector('#btn-revert').click());
}

async function produceThrough(page, types) {
    for (const type of types) {
        await produceUntilIntrusion(page, type);
        await resolveCurrentIntrusion(page);
    }
}

test('AI Intrusion Mechanics - Gemini 3s Auto-resolve Timer', async ({ page, browserName }) => {
    await page.goto('/');
    await observeImpact(page);

    const btnProduce = page.locator('#btn-produce');
    const banner = page.locator('#intrusion-banner');
    const title = page.locator('#intrusion-title');
    const message = page.locator('#intrusion-msg');

    await produceUntilIntrusion(page, 'copilot');
    const copilot = await expectImpact(page, impactTypes[0], browserName);
    await page.evaluate(() => document.querySelector('.upgrade-card button').click());
    const afterRender = await inspectImpact(page, 'copilot', browserName);
    expect(afterRender.targets.map((animation) => animation.identity)).toEqual(copilot.targets.map((animation) => animation.identity));
    expect(afterRender.targets.map((animation) => animation.startTime)).toEqual(copilot.targets.map((animation) => animation.startTime));
    await expectNaturalCleanup(page, impactTypes[0]);
    expect(await animationStarts(page)).toEqual(['intrusion-impact-copilot']);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    await produceUntilIntrusion(page, 'codex');
    await expectImpact(page, impactTypes[1], browserName);
    await expectNaturalCleanup(page, impactTypes[1]);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    await produceUntilIntrusion(page, 'gemini');
    await expectImpact(page, impactTypes[2], browserName);
    const activatedAt = await page.evaluate(() => performance.now());
    await expectNaturalCleanup(page, impactTypes[2]);
    await expect(banner).toBeVisible();
    await expect(title).toHaveText('✨ Gemini 응답 지연!');
    await expect(message).toHaveText('Gemini가 응답을 생성 중입니다... 3초 후 자동 해제되며 Esc로도 해제할 수 있습니다.');
    await expect(btnProduce).toBeDisabled();
    await page.waitForTimeout(1500);
    await expect(banner).toBeVisible();
    await expect(banner).toBeHidden({ timeout: 3000 });
    const resolvedAfterMs = await page.evaluate((startedAt) => performance.now() - startedAt, activatedAt);
    expect(resolvedAfterMs).toBeGreaterThanOrEqual(2700);
    expect(resolvedAfterMs).toBeLessThanOrEqual(5000);
    await expect(btnProduce).toBeEnabled();

    await produceUntilIntrusion(page, 'ceo');
    await expectImpact(page, impactTypes[3], browserName);
    await expectNaturalCleanup(page, impactTypes[3]);
    await page.locator('#btn-ceo-ship').click();
    await expect(page.locator('#ending-overlay')).toBeVisible();
    expect(await impactClassTransitions(page)).toEqual(impactTypes.map((spec) => spec.type));
    expect(await animationStarts(page)).toEqual(impactTypes.map((spec) => `intrusion-impact-${spec.type}`));
});

test('AI Intrusion Mechanics - CEO Order Reject (-500★ & +$500 cost)', async ({ page }) => {
    await page.goto('/');
    await observeImpact(page);

    await produceUntilIntrusion(page, 'copilot');
    const eventFiltering = await page.evaluate(() => {
        const body = document.body;
        const banner = document.querySelector('#intrusion-banner');
        document.querySelector('.main-grid').dispatchEvent(new AnimationEvent('animationend', { bubbles: true, animationName: 'intrusion-impact-copilot' }));
        const afterUnrelatedTarget = body.classList.contains('intrusion-impact--copilot');
        banner.dispatchEvent(new AnimationEvent('animationend', { animationName: 'intrusion-impact-ceo' }));
        const afterUnrelatedName = body.classList.contains('intrusion-impact--copilot');
        banner.dispatchEvent(new AnimationEvent('animationend', { animationName: 'intrusion-impact-copilot' }));
        return { afterUnrelatedTarget, afterUnrelatedName, afterMatchingEvent: body.classList.contains('intrusion-impact--copilot') };
    });
    expect(eventFiltering).toEqual({ afterUnrelatedTarget: true, afterUnrelatedName: true, afterMatchingEvent: false });

    await page.evaluate(() => window.__resetGameForTest());
    await produceUntilIntrusion(page, 'copilot');
    expect(await page.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        return { active: document.body.className.includes('intrusion-impact--'), focus: document.activeElement.id };
    })).toEqual({ active: false, focus: 'btn-produce' });

    await page.evaluate(() => window.__resetGameForTest());
    await produceUntilIntrusion(page, 'copilot');
    expect(await page.evaluate(() => {
        document.querySelector('#btn-revert').click();
        return { active: document.body.className.includes('intrusion-impact--'), focus: document.activeElement.id };
    })).toEqual({ active: false, focus: 'btn-produce' });

    await page.evaluate(() => window.__resetGameForTest());
    await produceUntilIntrusion(page, 'copilot');
    expect(await page.evaluate(() => {
        window.__resetGameForTest();
        return document.body.className.includes('intrusion-impact--');
    })).toBe(false);

    const startsBeforeReduce = (await animationStarts(page)).length;
    await produceUntilIntrusion(page, 'copilot');
    await expect.poll(() => page.evaluate(() => window.__intrusionAnimationStarts.length)).toBe(startsBeforeReduce + 1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('body')).not.toHaveClass(/intrusion-impact--/);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(440);
    await expect(page.locator('body')).not.toHaveClass(/intrusion-impact--/);
    expect((await animationStarts(page)).length).toBe(startsBeforeReduce + 1);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    await page.evaluate(() => window.__resetGameForTest());
    for (const type of ['copilot', 'codex', 'gemini']) {
        await produceUntilIntrusion(page, type);
        await page.evaluate(() => document.querySelector('#btn-revert').click());
    }
    await produceUntilIntrusion(page, 'ceo');
    const valStars = page.locator('#val-stars');
    const valCost = page.locator('#val-cost');
    const starsBefore = Number.parseInt((await valStars.innerText()).replace(/[^0-9]/g, ''), 10);
    const costBefore = Number.parseInt((await valCost.innerText()).replace(/[^0-9]/g, ''), 10);
    expect(await page.evaluate(() => {
        document.querySelector('#btn-revert').click();
        return document.body.className.includes('intrusion-impact--');
    })).toBe(false);
    const starsAfter = Number.parseInt((await valStars.innerText()).replace(/[^0-9]/g, ''), 10);
    const costAfter = Number.parseInt((await valCost.innerText()).replace(/[^0-9]/g, ''), 10);
    expect(starsBefore - starsAfter).toBe(500);
    expect(costAfter - costBefore).toBe(500);
    await page.evaluate(() => window.__resetGameForTest());

    for (const eventType of ['animationend', 'animationcancel']) {
        await page.evaluate(() => window.__resetGameForTest());
        await produceUntilIntrusion(page, 'copilot');
        const filtering = await page.evaluate(({ eventType, mutateCancel }) => {
            const body = document.body;
            const banner = document.querySelector('#intrusion-banner');
            const listenerTarget = mutateCancel ? banner.replaceWith(banner.cloneNode(true)) || document.querySelector('#intrusion-banner') : banner;
            const createEvent = (animationName) => new AnimationEvent(eventType, { bubbles: true, animationName });
            document.querySelector('.main-grid').dispatchEvent(createEvent('intrusion-impact-copilot'));
            const afterUnrelatedTarget = body.classList.contains('intrusion-impact--copilot');
            listenerTarget.dispatchEvent(createEvent('intrusion-impact-ceo'));
            const afterUnrelatedName = body.classList.contains('intrusion-impact--copilot');
            listenerTarget.dispatchEvent(createEvent('intrusion-impact-copilot'));
            return { afterUnrelatedTarget, afterUnrelatedName, afterMatchingEvent: body.classList.contains('intrusion-impact--copilot') };
        }, { eventType, mutateCancel: eventType === 'animationcancel' && controlledMutation === 'cancel-listener' });
        expect(filtering).toEqual({ afterUnrelatedTarget: true, afterUnrelatedName: true, afterMatchingEvent: false });
    }

    await page.evaluate(() => window.__resetGameForTest());
    await produceUntilIntrusion(page, 'copilot');
    await blockImpactRemoval(page, 'puzzle');
    const puzzleCleanup = await page.evaluate(() => {
        document.querySelector('.puzzle-option').click();
        return document.body.className.includes('intrusion-impact--');
    });
    await restoreImpactRemoval(page, 'puzzle');
    expect(puzzleCleanup).toBe(false);

    await page.evaluate(() => window.__resetGameForTest());
    await produceThrough(page, ['copilot', 'codex', 'gemini']);
    await produceUntilIntrusion(page, 'ceo');
    await blockImpactRemoval(page, 'ceo-ship');
    const ceoShipCleanup = await page.evaluate(() => {
        document.querySelector('#btn-ceo-ship').click();
        return { active: document.body.className.includes('intrusion-impact--'), ending: document.querySelector('#ending-overlay').style.display };
    });
    await restoreImpactRemoval(page, 'ceo-ship');
    expect(ceoShipCleanup).toEqual({ active: false, ending: 'flex' });

    await page.evaluate(() => window.__resetGameForTest());
    await produceUntilIntrusion(page, 'copilot');
    await blockImpactRemoval(page, 'penalty');
    const penaltyCleanup = await page.evaluate(() => {
        document.querySelector('#btn-accept-penalty').click();
        return { active: document.body.className.includes('intrusion-impact--'), focus: document.activeElement.id };
    });
    await restoreImpactRemoval(page, 'penalty');
    expect(penaltyCleanup).toEqual({ active: false, focus: 'btn-produce' });

    await page.evaluate(() => {
        window.__resetGameForTest();
        const originalSetTimeout = window.setTimeout;
        window.setTimeout = (callback, delay, ...args) => {
            if (delay === 3000) {
                window.__geminiTimerCallback = () => callback(...args);
                return 1;
            }
            return originalSetTimeout(callback, delay, ...args);
        };
    });
    await produceThrough(page, ['copilot', 'codex']);
    await produceUntilIntrusion(page, 'gemini');
    await blockImpactRemoval(page, 'gemini-timer');
    const geminiCleanup = await page.evaluate(() => {
        window.__geminiTimerCallback();
        return { active: document.body.className.includes('intrusion-impact--'), focus: document.activeElement.id };
    });
    await restoreImpactRemoval(page, 'gemini-timer');
    expect(geminiCleanup).toEqual({ active: false, focus: 'btn-produce' });
});
