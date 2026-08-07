import { test, expect } from '@playwright/test';

async function gameState(valUnits, valStars) {
    return {
        units: Number.parseInt(await valUnits.innerText(), 10),
        stars: Number.parseInt(await valStars.innerText(), 10)
    };
}

test('AI Intrusion Mechanics - Gemini 3s Auto-resolve Timer', async ({ page }) => {
    await page.goto('/');

    const btnProduce = page.locator('#btn-produce');
    const valUnits = page.locator('#val-units');
    const valStars = page.locator('#val-stars');
    const banner = page.locator('#intrusion-banner');
    const title = page.locator('#intrusion-title');
    const message = page.locator('#intrusion-msg');

    // Produce until 3rd intrusion (Gemini) triggers
    let geminiFound = false;
    for (let i = 0; i < 40; i++) {
        const state = await gameState(valUnits, valStars);
        if (await banner.isVisible()) {
            if (state.units === 150) {
                geminiFound = true;
                break;
            }
            // Clear copilot or codex with Escape
            await page.keyboard.press('Escape');
        } else {
            await btnProduce.click();
        }
    }

    expect(geminiFound).toBe(true);

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
});

test('AI Intrusion Mechanics - CEO Order Reject (-500★ & +$500 cost)', async ({ page }) => {
    await page.goto('/');

    const btnProduce = page.locator('#btn-produce');
    const valStars = page.locator('#val-stars');
    const valUnits = page.locator('#val-units');
    const valCost = page.locator('#val-cost');
    const banner = page.locator('#intrusion-banner');
    const title = page.locator('#intrusion-title');

    // Produce until 4th intrusion (CEO) triggers
    let ceoFound = false;
    for (let i = 0; i < 50; i++) {
        const state = await gameState(valUnits, valStars);
        if (await banner.isVisible()) {
            if (state.units === 200) {
                ceoFound = true;
                break;
            }
            await page.keyboard.press('Escape');
        } else {
            await btnProduce.click();
        }
    }

    expect(ceoFound).toBe(true);
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
});
