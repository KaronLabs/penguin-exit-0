export function parsePassingBrowserCounts(text, exitCode) {
    const engines = ['chromium', 'firefox', 'webkit'];
    const counts = {
        chromium: { passed: 0, failed: 0 },
        firefox: { passed: 0, failed: 0 },
        webkit: { passed: 0, failed: 0 },
        integrity: false,
        reportedFailures: exitCode === 0 ? 0 : Number(text.match(/^\s*(\d+)\s+failed\b/m)?.[1] ?? NaN) || null,
    };
    if (exitCode !== 0) return counts;
    const normalizedLines = text.split(/\r?\n/).map((line) => line.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, ''));
    const passingSummaries = normalizedLines.filter((line) => /^\s*\d+\s+passed\b/i.test(line));
    const exactFinalSummaries = normalizedLines.filter((line) => /^\s*48\s+passed\s+\([^)]+\)\s*$/i.test(line));
    const hasNonPassingSummary = normalizedLines.some((line) => /^\s*\d+\s+(?:failed|skipped|did not run)\b/i.test(line));
    if (passingSummaries.length !== 1 || exactFinalSummaries.length !== 1 || hasNonPassingSummary) return counts;
    const seenIndices = new Set();
    let invalidProgressEvidence = false;
    for (const line of normalizedLines) {
        const match = line.match(/\[(\d+)\/(\d+)\]\s+\[([^\]]+)\]/);
        if (!match) continue;
        const index = Number(match[1]);
        const denominator = Number(match[2]);
        const engine = match[3];
        if (denominator !== 48 || index < 1 || index > 48 || !engines.includes(engine) || seenIndices.has(index)) {
            invalidProgressEvidence = true;
            continue;
        }
        seenIndices.add(index);
        counts[engine].passed++;
    }
    const expectedIndicesPresent = seenIndices.size === 48;
    const engineCountsAreExact = engines.every((name) => counts[name].passed === 16);
    if (invalidProgressEvidence || !expectedIndicesPresent || !engineCountsAreExact) {
        counts.chromium.passed = 0;
        counts.firefox.passed = 0;
        counts.webkit.passed = 0;
        return counts;
    }
    counts.integrity = true;
    return counts;
}

export function browserCountsAreComplete(counts) {
    return counts.integrity === true && ['chromium', 'firefox', 'webkit'].every((name) => counts[name].passed === 16 && counts[name].failed === 0);
}
