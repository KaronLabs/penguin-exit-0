import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const verifierSource = path.resolve('scripts/verify-campaign.mjs');

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function makeFixture() {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-verifier-'));
    const root = path.join(workspace, 'project');
    const review = path.join(workspace, 'review');
    const campaign = path.join(root, 'evidence', 'campaigns', 'run-1');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'evidence', 'performance'), { recursive: true });
    fs.mkdirSync(campaign, { recursive: true });
    fs.mkdirSync(review, { recursive: true });
    fs.copyFileSync(verifierSource, path.join(root, 'scripts', 'verify-campaign.mjs'));

    const spec = path.join(review, 'spec.md');
    fs.writeFileSync(spec, '# sealed spec\n');
    const started = '2026-08-07T00:00:00.000Z';
    const ended = '2026-08-07T00:10:00.000Z';
    writeJson(path.join(root, 'evidence', 'performance', 'performance-summary.json'), {
        startedUtc: started,
        endedUtc: ended,
        measuredDurationMs: 600000,
        sampleCount: 10000,
    });
    writeJson(path.join(root, 'evidence', 'performance', 'frame-samples.json'), {
        startedUtc: started,
        endedUtc: ended,
        frameDeltasMs: Array(10000).fill(16.7),
    });

    const states = [
        ['CREATED', '2026-08-06T23:59:59.000Z'],
        ['PREFLIGHT_PASS', '2026-08-06T23:59:59.100Z'],
        ['UNIT_PASS', '2026-08-06T23:59:59.200Z'],
        ['BROWSER_PASS', '2026-08-06T23:59:59.300Z'],
        ['PERFORMANCE_PASS', ended],
        ['NEGATIVE_CONTROLS_PASS', '2026-08-07T00:10:00.100Z'],
        ['FINAL_GATE_PASS', '2026-08-07T00:10:00.200Z'],
        ['READY_TO_FREEZE', '2026-08-07T00:10:00.300Z'],
    ];
    fs.writeFileSync(path.join(campaign, 'ledger.jsonl'), states.map(([state, timestampUtc]) => JSON.stringify({
        schemaVersion: 2,
        runId: 'run-1',
        state,
        timestampUtc,
        command: state === 'CREATED' || state === 'READY_TO_FREEZE' ? null : {
            argv: ['node', 'proof.mjs'], cwd: root, startedUtc: timestampUtc,
            endedUtc: timestampUtc, exitCode: 0, stdoutSha256: 'A'.repeat(64), stderrSha256: 'B'.repeat(64),
        },
    })).join('\n') + '\n');
    const claims = {
        runId: 'run-1',
        unit: { tests: 24, passed: 24, failed: 0, exitCode: 0 },
        browser: {
            chromium: { passed: 7, failed: 0 }, firefox: { passed: 7, failed: 0 }, webkit: { passed: 7, failed: 0 }, exitCode: 0,
        },
    };
    writeJson(path.join(campaign, 'claims.json'), claims);
    const report = path.join(root, 'docs', 'final-report.md');
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, '| Node TAP | 24 | 0 | 0 |\n| Chromium | 7 | 0 | 0 |\n| Firefox | 7 | 0 | 0 |\n| WebKit | 7 | 0 | 0 |\n| Measured duration ms | 600000 |\n| Sample count | 10000 |\n');
    writeJson(path.join(root, 'evidence', 'manifest.json'), { totalFilesCount: 0, files: [] });
    fs.copyFileSync(path.join(root, 'evidence', 'manifest.json'), path.join(campaign, 'artifact-manifest.json'));

    const payloadHashes = {};
    for (const name of ['ledger.jsonl', 'claims.json', 'artifact-manifest.json']) {
        payloadHashes[name] = sha256(path.join(campaign, name));
    }
    writeJson(path.join(campaign, 'submission-envelope.json'), {
        schemaVersion: 2,
        runId: 'run-1',
        specPath: spec,
        payloadHashes,
        spec: { path: spec, sizeBytes: fs.statSync(spec).size, sha256: sha256(spec) },
        rawEvidence: {
            summary: { path: path.join(root, 'evidence', 'performance', 'performance-summary.json'), sha256: sha256(path.join(root, 'evidence', 'performance', 'performance-summary.json')) },
            samples: { path: path.join(root, 'evidence', 'performance', 'frame-samples.json'), sha256: sha256(path.join(root, 'evidence', 'performance', 'frame-samples.json')) },
        },
        report: { path: report, sha256: sha256(report) },
    });
    return { workspace, root, campaign, spec };
}

function verify(fixture) {
    return spawnSync(process.execPath, ['scripts/verify-campaign.mjs', '--run', 'run-1'], {
        cwd: fixture.root,
        encoding: 'utf8',
    });
}

test('accepts a fully bound campaign', (t) => {
    const f = makeFixture();
    t.after(() => fs.rmSync(f.workspace, { recursive: true, force: true }));
    const result = verify(f);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /CAMPAIGN_GATE=PASS/);
});

test('rejects an envelope that omits one required payload hash', (t) => {
    const f = makeFixture();
    t.after(() => fs.rmSync(f.workspace, { recursive: true, force: true }));
    const envelopePath = path.join(f.campaign, 'submission-envelope.json');
    const envelope = JSON.parse(fs.readFileSync(envelopePath));
    delete envelope.payloadHashes['claims.json'];
    writeJson(envelopePath, envelope);
    assert.equal(verify(f).status, 1);
});

test('rejects a changed spec instead of merely proving it exists', (t) => {
    const f = makeFixture();
    t.after(() => fs.rmSync(f.workspace, { recursive: true, force: true }));
    fs.appendFileSync(f.spec, 'tampered\n');
    assert.equal(verify(f).status, 1);
});

test('rejects missing or reordered ledger states', (t) => {
    const f = makeFixture();
    t.after(() => fs.rmSync(f.workspace, { recursive: true, force: true }));
    const ledger = path.join(f.campaign, 'ledger.jsonl');
    const entries = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
    const unit = entries.findIndex((entry) => entry.state === 'UNIT_PASS');
    const browser = entries.findIndex((entry) => entry.state === 'BROWSER_PASS');
    [entries[unit].state, entries[browser].state] = [entries[browser].state, entries[unit].state];
    fs.writeFileSync(ledger, entries.map(JSON.stringify).join('\n') + '\n');
    const envelopePath = path.join(f.campaign, 'submission-envelope.json');
    const envelope = JSON.parse(fs.readFileSync(envelopePath));
    envelope.payloadHashes['ledger.jsonl'] = sha256(ledger);
    writeJson(envelopePath, envelope);
    assert.equal(verify(f).status, 1);
});

test('rejects raw evidence that is not hash-bound by the envelope', (t) => {
    const f = makeFixture();
    t.after(() => fs.rmSync(f.workspace, { recursive: true, force: true }));
    const summary = path.join(f.root, 'evidence', 'performance', 'performance-summary.json');
    const data = JSON.parse(fs.readFileSync(summary));
    data.sampleCount = 9999;
    writeJson(summary, data);
    assert.equal(verify(f).status, 1);
});

test('rejects a report whose bound claims are stale', (t) => {
    const f = makeFixture();
    t.after(() => fs.rmSync(f.workspace, { recursive: true, force: true }));
    const envelopePath = path.join(f.campaign, 'submission-envelope.json');
    const envelope = JSON.parse(fs.readFileSync(envelopePath));
    fs.writeFileSync(envelope.report.path, 'Node TAP 19 19 0\n');
    envelope.report.sha256 = sha256(envelope.report.path);
    writeJson(envelopePath, envelope);
    assert.equal(verify(f).status, 1);
});
