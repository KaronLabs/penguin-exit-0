import test from 'node:test';
import assert from 'node:assert/strict';
import { browserCountsAreComplete, parsePassingBrowserCounts } from '../scripts/campaign-evidence.mjs';

function progressLines({ denominator = 48, engineForIndex = (index) => (index <= 16 ? 'chromium' : index <= 32 ? 'firefox' : 'webkit'), omit = new Set(), duplicate = [] } = {}) {
    const lines = [];
    for (let index = 1; index <= 48; index++) {
        if (!omit.has(index)) lines.push(`[${index}/${denominator}] [${engineForIndex(index)}] › test-${index}`);
    }
    for (const index of duplicate) lines.push(`[${index}/${denominator}] [${engineForIndex(index)}] › duplicate-${index}`);
    return lines.join('\n');
}

test('parses ANSI Playwright line reporter output by engine', () => {
    const lines = [];
    for (const [engine, start] of [['chromium', 1], ['firefox', 17], ['webkit', 33]]) {
        for (let i = 0; i < 16; i++) lines.push(`\u001b[1A\u001b[2K[${start + i}/48] [${engine}] › test-${i}`);
    }
    lines.push('\u001b[32m  48 passed (6.2s)\u001b[39m');
    const counts = parsePassingBrowserCounts(lines.join('\n'), 0);
    assert.deepEqual(counts, {
        chromium: { passed: 16, failed: 0 },
        firefox: { passed: 16, failed: 0 },
        webkit: { passed: 16, failed: 0 },
        integrity: true,
        reportedFailures: 0,
    });
    assert.equal(browserCountsAreComplete(counts), true);
});

test('never converts failed or malformed browser evidence into passing counts', () => {
    const cases = [
        { name: 'wrong denominator', text: progressLines({ denominator: 21 }), exitCode: 0, engine: 'chromium' },
        { name: 'duplicate and missing index', text: progressLines({ omit: new Set([48]), duplicate: [1] }), exitCode: 0, engine: 'webkit' },
        { name: 'wrong engine membership', text: progressLines({ engineForIndex: (index) => (index <= 17 ? 'chromium' : index <= 32 ? 'firefox' : 'webkit') }), exitCode: 0, engine: 'firefox' },
        { name: 'unknown project label', text: progressLines({ engineForIndex: (index) => (index === 48 ? 'integrity' : index <= 16 ? 'chromium' : index <= 32 ? 'firefox' : 'webkit') }), exitCode: 0, engine: 'webkit' },
        { name: 'failed command', text: '[1/48] [chromium] › test', exitCode: 1, engine: 'chromium' },
        { name: 'missing final summary', text: progressLines(), exitCode: 0, engine: 'chromium' },
        { name: 'skipped summary', text: `${progressLines()}\n  48 passed (6s)\n  1 skipped`, exitCode: 0, engine: 'chromium' },
        { name: 'failed summary', text: `${progressLines()}\n  48 passed (6s)\n  1 failed`, exitCode: 0, engine: 'chromium' },
        { name: 'did not run summary', text: `${progressLines()}\n  48 passed (6s)\n  1 did not run`, exitCode: 0, engine: 'chromium' },
        { name: 'duplicate passing summaries', text: `${progressLines()}\n  48 passed (6s)\n  48 passed (6s)`, exitCode: 0, engine: 'chromium' },
    ];

    for (const { name, text, exitCode, engine } of cases) {
        const counts = parsePassingBrowserCounts(text, exitCode);
        assert.equal(counts.integrity, false, name);
        assert.equal(browserCountsAreComplete(counts), false, name);
        assert.equal(counts[engine].passed, 0, name);
    }
});
