import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function resetGameAndAssert(page) {
    const state = await page.evaluate(() => {
        if (typeof window.__resetGameForTest !== 'function') {
            throw new Error('window.__resetGameForTest is required for the performance workload');
        }
        window.__resetGameForTest();
        const units = Number.parseInt(document.querySelector('#val-units').textContent, 10);
        const stars = Number.parseInt(document.querySelector('#val-stars').textContent, 10);
        const endingVisible = getComputedStyle(document.querySelector('#ending-overlay')).display !== 'none';
        if (units !== 0 || stars !== 0 || endingVisible) {
            throw new Error(`Reset did not restore initial state: units=${units}, stars=${stars}, endingVisible=${endingVisible}`);
        }
        return { units, stars, endingVisible };
    });
    expect(state).toEqual({ units: 0, stars: 0, endingVisible: false });
}

function calculatePercentile(samples, ratio) {
    if (samples.length === 0) throw new Error('Frame samples collection is empty');
    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
    return sorted[index];
}

function requireHeapMetric(metricsResult, phase) {
    const metric = metricsResult.metrics.find((entry) => entry.name === 'JSHeapUsedSize');
    if (!metric || !Number.isFinite(metric.value) || metric.value <= 0) {
        throw new Error(`CDP JSHeapUsedSize metric missing or invalid during ${phase}`);
    }
    return metric.value / (1024 * 1024);
}

// This test MUST run only on chromium-perf project (CDP is Chromium-only).
// playwright.config.js assigns @performance tag to chromium-perf project only.
test('@performance - Real 600s Frame Latency, Long Task and CDP Heap Measurement', async ({ page }) => {
    const warmupMs = 30000;
    const targetWorkloadMs = 600000;
    test.setTimeout(targetWorkloadMs + warmupMs + 120000);

    await page.goto('/');
    await resetGameAndAssert(page);

    // 1. Install PerformanceObserver and Zero-Allocation Frame Delta collector
    await page.evaluate(() => {
        window.__frameDeltas = [];
        window.__longTasks = [];
        window.__longTaskObserverSupported = false;
        let lastTime = performance.now();

        function frameLoop(now) {
            const delta = now - lastTime;
            lastTime = now;
            if (delta > 0 && delta < 1000) {
                window.__frameDeltas.push(delta);
            }
            requestAnimationFrame(frameLoop);
        }
        requestAnimationFrame(frameLoop);

        if ('PerformanceObserver' in window) {
            try {
                const observer = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        window.__longTasks.push({
                            startTime: entry.startTime,
                            duration: entry.duration
                        });
                    }
                });
                observer.observe({ entryTypes: ['longtask'] });
                window.__longTaskObserverSupported = true;
            } catch (e) {
                // longtask entry type not supported — will be reported as false
            }
        }
    });

    // Warm-up phase
    console.log(`[PERF] Warming up for ${warmupMs / 1000}s...`);
    await page.waitForTimeout(warmupMs);
    await page.evaluate(() => {
        window.__frameDeltas.length = 0;
        window.__longTasks.length = 0;
    });

    // CDP — Chromium-only. playwright.config.js MUST route this test to chromium-perf only.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.collectGarbage');

    const startMetrics = await cdp.send('Performance.getMetrics');
    const startHeap = requireHeapMetric(startMetrics, 'measurement start');

    // Active workload loop
    const btnProduce = page.locator('#btn-produce');
    const banner = page.locator('#intrusion-banner');
    const endingOverlay = page.locator('#ending-overlay');
    const startTime = await page.evaluate(() => {
        window.__frameDeltas.length = 0;
        window.__longTasks.length = 0;
        return Date.now();
    });
    let actionCount = 0;

    console.log(`[PERF] Starting workload measurement loop for ${targetWorkloadMs / 1000}s...`);

    while (Date.now() - startTime < targetWorkloadMs) {
        if (await endingOverlay.isVisible()) {
            await resetGameAndAssert(page);
        } else if (await banner.isVisible()) {
            await page.keyboard.press('Escape');
        } else {
            const state = await page.evaluate(() => ({
                units: Number.parseInt(document.querySelector('#val-units').textContent, 10),
                stars: Number.parseInt(document.querySelector('#val-stars').textContent, 10)
            }));
            if (state.units === 200 && state.stars === 3000) {
                await resetGameAndAssert(page);
            } else {
                await btnProduce.click();
                actionCount++;
            }
        }
        await page.waitForTimeout(16);
    }

    const measurementSnapshot = await page.evaluate(() => ({
        endTime: Date.now(),
        frameDeltas: [...window.__frameDeltas],
        longTasks: [...window.__longTasks],
        longTaskObserverSupported: window.__longTaskObserverSupported
    }));
    const endTime = measurementSnapshot.endTime;
    const measuredDurationMs = endTime - startTime;

    await cdp.send('HeapProfiler.collectGarbage');
    const endMetrics = await cdp.send('Performance.getMetrics');
    const endHeap = requireHeapMetric(endMetrics, 'measurement end');
    const heapNetGrowthMb = Math.max(0, endHeap - startHeap);

    const frameDeltas = measurementSnapshot.frameDeltas;
    const longTasks = measurementSnapshot.longTasks;

    // Hard contract assertions
    expect(measuredDurationMs).toBeGreaterThanOrEqual(600000);
    expect(frameDeltas.length).toBeGreaterThanOrEqual(10000);
    expect(actionCount).toBeGreaterThanOrEqual(Math.floor(measuredDurationMs / 1000));

    const p50 = calculatePercentile(frameDeltas, 0.50);
    const p95 = calculatePercentile(frameDeltas, 0.95);
    const p99 = calculatePercentile(frameDeltas, 0.99);

    // Save atomic evidence files
    const evidenceDir = path.resolve(__dirname, '../../evidence/performance');
    if (!fs.existsSync(evidenceDir)) {
        fs.mkdirSync(evidenceDir, { recursive: true });
    }

    const rawSamplesData = {
        startedUtc: new Date(startTime).toISOString(),
        endedUtc: new Date(endTime).toISOString(),
        measuredDurationMs: measuredDurationMs,
        sampleCount: frameDeltas.length,
        frameDeltasMs: frameDeltas,
        longTaskObserverSupported: measurementSnapshot.longTaskObserverSupported,
        longTasksEntries: longTasks
    };
    fs.writeFileSync(path.join(evidenceDir, 'frame-samples.json'), JSON.stringify(rawSamplesData, null, 2), 'utf-8');

    const perfSummary = {
        startedUtc: new Date(startTime).toISOString(),
        endedUtc: new Date(endTime).toISOString(),
        measuredDurationMs: measuredDurationMs,
        environment: {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            project: 'chromium-perf'
        },
        sampleCount: frameDeltas.length,
        rawMinMs: Math.min(...frameDeltas),
        rawMaxMs: Math.max(...frameDeltas),
        p50LatencyMs: p50,
        p95LatencyMs: p95,
        p99LatencyMs: p99,
        longTaskObserverSupported: measurementSnapshot.longTaskObserverSupported,
        longTasksCount: longTasks.length,
        heapStartMb: startHeap,
        heapEndMb: endHeap,
        heapNetGrowthMb: heapNetGrowthMb,
        totalActionsCount: actionCount
    };
    fs.writeFileSync(path.join(evidenceDir, 'performance-summary.json'), JSON.stringify(perfSummary, null, 2), 'utf-8');

    console.log(`[PERF SUMMARY] Duration: ${measuredDurationMs}ms, Samples: ${frameDeltas.length}, P95: ${p95}ms, P99: ${p99}ms, LongTasks: ${longTasks.length}, HeapNet: ${heapNetGrowthMb.toFixed(2)}MB`);

    // Strict contract assertions
    expect(p95).toBeLessThanOrEqual(20.0);
    expect(p99).toBeLessThanOrEqual(33.3);
    expect(measurementSnapshot.longTaskObserverSupported).toBe(true);
    expect(longTasks.length).toBe(0);
    expect(heapNetGrowthMb).toBeLessThanOrEqual(5.0);
});
