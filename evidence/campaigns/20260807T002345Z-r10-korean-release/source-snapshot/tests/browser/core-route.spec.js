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

    for (let i = 0; i < 80; i++) {
        if (await endingOverlay.isVisible()) break;
        if (await banner.isVisible()) {
            await page.keyboard.press('Escape');
        } else {
            const state = await gameState(valUnits, valStars);
            if (state.units === 200 && state.stars === 3000) break;
            await btnProduce.click();
        }
    }

    await expect(valUnits).toHaveText('200 / 200');
    await expect(valStars).toHaveText('3000 ★');
    await expect(endingOverlay).toBeVisible();
});

test('Core Route - Upgrade Route (Buy Coffee upgrade & RECOVER)', async ({ page }) => {
    await page.goto('/');

    const btnProduce = page.locator('#btn-produce');
    const valUnits = page.locator('#val-units');
    const valStars = page.locator('#val-stars');
    const banner = page.locator('#intrusion-banner');
    const endingOverlay = page.locator('#ending-overlay');

    for (let i = 0; i < 80; i++) {
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
            if (state.units === 200 && state.stars === 3000) break;
            await btnProduce.click();
        }
    }

    await expect(valUnits).toHaveText('200 / 200');
    await expect(valStars).toHaveText('3000 ★');
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
                // Accept penalty once to drop stars below 3000
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

    // Verify RECOVER button state when units=200 and stars<3000
    await expect(btnProduce).toHaveText(/RECOVER/);
    await expect(btnProduce).toBeEnabled();

    const starsBeforeRecover = parseInt((await valStars.innerText()).replace(/[^0-9]/g, ''), 10);
    expect(starsBeforeRecover).toBeLessThan(3000);

    // Click RECOVER button and check +150 star gain
    await btnProduce.click();
    const starsAfterFirstRecover = parseInt((await valStars.innerText()).replace(/[^0-9]/g, ''), 10);
    expect(starsAfterFirstRecover - starsBeforeRecover).toBe(150);

    // Continue recovery while numeric state still has a star deficit.
    for (let i = 0; i < 20; i++) {
        const state = await gameState(valUnits, valStars);
        if (state.stars === 3000 || await endingOverlay.isVisible()) break;
        await btnProduce.click();
    }

    await expect(valStars).toHaveText('3000 ★');
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

    for (let i = 0; i < 80; i++) {
        if (await endingOverlay.isVisible()) break;
        if (await banner.isVisible()) {
            await page.keyboard.press('Escape');
        } else {
            const state = await gameState(valUnits, valStars);
            if (state.units === 200 && state.stars === 3000) break;
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

    // Verify Play Again button inside ending overlay
    const playAgainBtn = endingOverlay.locator('#btn-play-again');
    await expect(playAgainBtn).toBeVisible();
    await expect(playAgainBtn).toHaveText('다시 플레이');
});
