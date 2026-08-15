import { test, expect } from '@playwright/test';

async function gameState(valUnits, valStars) {
    return {
        units: Number.parseInt(await valUnits.innerText(), 10),
        stars: Number.parseInt(await valStars.innerText(), 10)
    };
}

test('Core Route - Happy Path (No upgrade, no penalty)', async ({ page }) => {
    await page.goto('/');

    const btnProduce = page.locator('#btn-produce');
    const valUnits = page.locator('#val-units');
    const valStars = page.locator('#val-stars');
    const banner = page.locator('#intrusion-banner');
    const endingOverlay = page.locator('#ending-overlay');

    let observedRecoveryBeforeTarget = false;
    for (let i = 0; i < 100; i++) {
        if (await endingOverlay.isVisible()) break;
        if (await banner.isVisible()) {
            await page.keyboard.press('Escape');
        } else {
            const state = await gameState(valUnits, valStars);
            if (state.units === 200 && state.stars < 9000) {
                observedRecoveryBeforeTarget = true;
                await expect(page.locator('#stage-badge')).toHaveText('5단계 · 복구 중');
                await expect(endingOverlay).toBeHidden();
            }
            await btnProduce.click();
        }
    }

    expect(observedRecoveryBeforeTarget).toBe(true);
    await expect(valUnits).toHaveText('200 / 200');
    await expect(valStars).toHaveText('9000 ★');
    await expect(page.locator('#stage-badge')).toHaveText('5단계 · 마이애미 해변의 AGI 재벌 · EXIT 0');
    await expect(endingOverlay).toBeVisible();
});

test('Core Route - Upgrade Route (Buy Coffee upgrade & RECOVER)', async ({ page }) => {
    await page.goto('/');

    const btnProduce = page.locator('#btn-produce');
    const valUnits = page.locator('#val-units');
    const valStars = page.locator('#val-stars');
    const banner = page.locator('#intrusion-banner');
    const endingOverlay = page.locator('#ending-overlay');

    for (let i = 0; i < 100; i++) {
        if (await endingOverlay.isVisible()) break;
        if (await banner.isVisible()) {
            await page.keyboard.press('Escape');
        } else {
            // Buy Coffee upgrade if affordable
            const buyCoffeeBtn = page.locator('.upgrade-card button').first();
            if (await buyCoffeeBtn.isVisible() && await buyCoffeeBtn.isEnabled()) {
                await buyCoffeeBtn.click();
            }

            const state = await gameState(valUnits, valStars);
            await btnProduce.click();
        }
    }

    await expect(valUnits).toHaveText('200 / 200');
    await expect(valStars).toHaveText('9000 ★');
    await expect(endingOverlay).toBeVisible();
});

test('Core Route - Penalty Route & RECOVER Button Mechanics', async ({ page }) => {
    await page.goto('/');

    const btnProduce = page.locator('#btn-produce');
    const valUnits = page.locator('#val-units');
    const valStars = page.locator('#val-stars');
    const banner = page.locator('#intrusion-banner');
    const endingOverlay = page.locator('#ending-overlay');

    let penaltyAccepted = false;
    for (let i = 0; i < 50; i++) {
        const state = await gameState(valUnits, valStars);
        if (state.units === 200 && !await banner.isVisible()) break;
        if (await banner.isVisible()) {
            if (!penaltyAccepted) {
                // Accept penalty once to extend the recovery route
                await page.locator('#btn-accept-penalty').click();
                penaltyAccepted = true;
            } else {
                await page.keyboard.press('Escape');
            }
        } else {
            await btnProduce.click();
        }
    }

    await expect(valUnits).toHaveText('200 / 200');

    // Verify RECOVER button state when units=200 and stars<9000
    await expect(btnProduce).toHaveText(/RECOVER/);
    await expect(btnProduce).toBeEnabled();

    const starsBeforeRecover = parseInt((await valStars.innerText()).replace(/[^0-9]/g, ''), 10);
    expect(starsBeforeRecover).toBeLessThan(9000);

    // Click RECOVER button and check +150 star gain
    await btnProduce.click();
    const starsAfterFirstRecover = parseInt((await valStars.innerText()).replace(/[^0-9]/g, ''), 10);
    expect(starsAfterFirstRecover - starsBeforeRecover).toBe(150);

    for (let recovery = 0; recovery < 4; recovery += 1) await btnProduce.click();
    await expect(banner).toBeVisible();
    await expect(page.locator('#intrusion-title')).toHaveText('🤖 Copilot 코드 침입!');
    await expect(btnProduce).toBeDisabled();
    await page.keyboard.press('Escape');

    // Continue recovery while numeric state still has a star deficit.
    for (let i = 0; i < 100; i++) {
        const state = await gameState(valUnits, valStars);
        if (state.stars === 9000 || await endingOverlay.isVisible()) break;
        if (await banner.isVisible()) await page.keyboard.press('Escape');
        else await btnProduce.click();
    }

    await expect(valStars).toHaveText('9000 ★');
    await expect(btnProduce).toBeDisabled();
    await expect(endingOverlay).toBeVisible();
});

test('Core Route - 1-Shot Ending Modal Overlay Verification', async ({ page }) => {
    await page.goto('/');

    const btnProduce = page.locator('#btn-produce');
    const valUnits = page.locator('#val-units');
    const valStars = page.locator('#val-stars');
    const banner = page.locator('#intrusion-banner');
    const endingOverlay = page.locator('#ending-overlay');

    for (let i = 0; i < 100; i++) {
        if (await endingOverlay.isVisible()) break;
        if (await banner.isVisible()) {
            await page.keyboard.press('Escape');
        } else {
            const state = await gameState(valUnits, valStars);
            await btnProduce.click();
        }
    }

    await expect(endingOverlay).toBeVisible();

    // Verify 1-Shot ending modal overlay contents and layout
    await expect(endingOverlay.locator('#ending-process-heading')).toHaveText('프로세스는 살아남았습니다');
    await expect(endingOverlay.locator('.ending-process-code')).toHaveText('🎉 PROCESS EXIT CODE: 0');
    await expect(endingOverlay.locator('.ending-financial-heading')).toHaveText('회계는 죽었습니다');
    await expect(endingOverlay.locator('.ending-financial-code')).toHaveText('💸 FINANCIAL EXIT CODE: 1');
    await expect(endingOverlay).toContainText('인수 대금 +$3,000');
    await expect(endingOverlay).toContainText('GPU 청구액 -$3,001');
    await expect(endingOverlay).toContainText('순 재무 잔액 -$1');
    await expect(page.locator('#ending-incident-cost')).toContainText('장애 비용 -$');

    const endingImage = endingOverlay.locator('#ending-acquisition-image');
    await expect(endingOverlay.locator('.ending-divider')).toBeVisible();
    await expect(endingImage).toBeVisible();
    await expect(endingImage).toHaveAttribute(
        'alt',
        'AI 기업 인수식에서 정장 펭귄이 계약서를 받고 AGI 로봇이 참치 뱃살을 탐내는 동안 GPU 청구서가 쏟아지는 장면'
    );
    await expect.poll(async () => endingImage.evaluate((image) => ({
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight
    }))).toEqual({
        complete: true,
        naturalWidth: 1672,
        naturalHeight: 941
    });

    const endingOrder = await endingOverlay.locator('.ending-dialog').evaluate((dialog) => {
        const selectors = [
            '.ending-summary',
            '.ending-divider',
            '#ending-acquisition-image',
            '.ending-offer',
            '.ending-title',
            '#btn-play-again'
        ];
        return selectors.map((selector) => Array.from(dialog.children).indexOf(dialog.querySelector(selector)));
    });
    expect(endingOrder).toEqual([4, 5, 6, 7, 8, 9]);

    // Verify Play Again button inside ending overlay
    const playAgainBtn = endingOverlay.locator('#btn-play-again');
    await expect(playAgainBtn).toBeVisible();
    await expect(playAgainBtn).toHaveText('다시 플레이');
});

for (const viewport of [
    { width: 320, height: 640 },
    { width: 640, height: 360 }
]) {
    test(`Ending Modal - ${viewport.width}x${viewport.height} reflow keeps image and replay reachable`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto('/');
        await page.locator('#ending-overlay').evaluate((overlay) => {
            overlay.style.display = 'flex';
        });

        const dialog = page.locator('.ending-dialog');
        const image = page.locator('#ending-acquisition-image');
        const playAgain = page.locator('#btn-play-again');
        await expect(image).toBeVisible();

        const geometry = await dialog.evaluate((element) => ({
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight
        }));
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
        expect(geometry.clientHeight).toBeLessThanOrEqual(viewport.height);

        await playAgain.scrollIntoViewIfNeeded();
        await expect(playAgain).toBeInViewport();
        await expect(playAgain).toBeVisible();
    });
}
