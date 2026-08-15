import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import {
  createRunnerEventLedger,
  enforceStrictDeadline,
  validateCase,
  validateTask2Case,
  validateOperationReceipt,
  validateSignature,
  validateRunnerSourcePolicy,
} from '../../scripts/public-smoke-v2-lib.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function startCurrentProductServer() {
  const contentTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'application/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
  ]);
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!['index.html', 'content.js', 'game-core.js', 'script.js', 'style.css'].includes(relative)) {
        response.writeHead(404).end();
        return;
      }
      const body = await readFile(path.join(projectRoot, relative));
      response.writeHead(200, { 'content-type': contentTypes.get(path.extname(relative)), 'content-length': body.length });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' }).end(String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('runner module exposes the four read-only probes and operation entry points', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');

  assert.equal(typeof runner.readDocumentSnapshot, 'function');
  assert.equal(typeof runner.readVisibilityPrimitives, 'function');
  assert.equal(typeof runner.readStatePrimitives, 'function');
  assert.equal(typeof runner.readScreenshotOracle, 'function');
  assert.equal(typeof runner.runCase, 'function');
  assert.equal(typeof runner.runAcceptedSmoke, 'function');
});

const forbiddenSources = [
  ['direct hook', 'window.__resetGameForTest()'],
  ['aliased hook', 'const reset = window.__resetGameForTest; reset()'],
  ['destructured hook', 'const { __resetGameForTest: reset } = window; reset()'],
  ['computed hook', "window['__reset' + 'GameForTest']()"],
  ['optional hook', 'window?.__resetGameForTest?.()'],
  ['forced locator input', "await page.locator('#x').click({ force: true })"],
  ['aliased dispatch', 'const send = node.dispatchEvent.bind(node); send(event)'],
  ['destructured storage write', 'const { setItem } = localStorage; setItem(key, value)'],
  ['computed storage clear', "sessionStorage['cl' + 'ear']()"],
  ['optional style write', "node?.style['display'] = 'block'"],
  ['style attribute write', "node.setAttribute('style', 'display:block')"],
  ['destructured init script', 'const { addInitScript } = context; await addInitScript(fn)'],
  ['computed style tag', "await page['add' + 'StyleTag']({ content: css })"],
  ['aliased route', 'const intercept = page.route.bind(page); await intercept(pattern, handler)'],
  ['optional HAR route', 'await page?.routeFromHAR?.(archive)'],
  ['destructured fulfill', 'const { fulfill } = route; await fulfill(response)'],
  ['computed content injection', "await page['set' + 'Content'](html)"],
  ['generic DOM insertion', 'target.append(child)'],
  ['aliased DOM insertion', 'const add = target.append.bind(target); add(child)'],
  ['destructured DOM removal', 'const { remove: detach } = target; detach()'],
  ['computed DOM replacement', "target['replace' + 'Children'](child)"],
  ['optional DOM replacement', 'target?.replaceWith?.(child)'],
  ['storage-state injection', 'await browser.newContext({ storageState: saved })'],
  ['cookie injection', 'await context.addCookies(cookies)'],
  ['CDP session', 'await context.newCDPSession(page)'],
  ['evaluate receiver alias', 'const p = page; p.evaluate(() => document.title)'],
  ['evaluate destructure', 'const { evaluate } = page; evaluate(() => document.title)'],
  ['evaluate computed', "page['eva' + 'luate'](() => document.title)"],
  ['evaluate optional bracket', "page?.['evaluate']?.(() => document.title)"],
  ['hidden property mutation', 'node.hidden = true'],
  ['text content mutation', "node.textContent = 'forged'"],
  ['product call timer', 'setTimeout(() => window.startGame(), 0)'],
];

for (const [name, source] of forbiddenSources) {
  test(`static policy rejects ${name}`, () => {
    assert.throws(() => validateRunnerSourcePolicy(source), /runner\.policy/);
  });
}

test('static policy accepts only the four named read probes and trusted Playwright input', () => {
  const source = `
    await readDocumentSnapshot(page);
    await readVisibilityPrimitives(page, '#ending-overlay');
    await readStatePrimitives(page);
    await readScreenshotOracle(page);
    await page.getByRole('button', { name: 'Wi-Fi 장애' }).click();
    await page.keyboard.press('Shift+Tab');
  `;

  assert.doesNotThrow(() => validateRunnerSourcePolicy(source));
});

test('static policy rejects page.evaluate outside a named read probe', () => {
  assert.throws(
    () => validateRunnerSourcePolicy('async function mutate(page) { return page.evaluate(() => document.title); }'),
    /runner\.policy\.evaluate/,
  );
});

test('runner source passes its own static policy', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = await readFile(path.join(root, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8');
  assert.doesNotThrow(() => validateRunnerSourcePolicy(source));
});

test('read probes return primitive DOM state without changing page bytes', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
  try {
    await page.goto('data:text/html,' + encodeURIComponent(`<!doctype html><html><body>
      <button id="btn-produce" aria-label="produce">Go</button>
      <div id="target" role="status" data-kind="sample">Visible</div>
    </body></html>`));
    const before = await page.content();
    const documentSnapshot = await runner.readDocumentSnapshot(page);
    const visibility = await runner.readVisibilityPrimitives(page, '#target');
    const state = await runner.readStatePrimitives(page);
    const oracle = await runner.readScreenshotOracle(page);
    const after = await page.content();

    assert.equal(documentSnapshot.url, page.url());
    assert.equal(documentSnapshot.title, '');
    assert.equal(visibility.hiddenAttribute, false);
    assert.equal(visibility.hitIsSelfOrDescendant, true);
    assert.equal(state.produceAccessibleName, 'produce');
    assert.equal(oracle.viewport.width, 320);
    assert.equal(oracle.viewport.height, 640);
    assert.equal(after, before);
  } finally {
    await browser.close();
  }
});

test('event ledger seals an exact canonical SHA-256 chain', () => {
  const ledger = createRunnerEventLedger();
  const first = ledger.append({ utc: '2026-08-14T00:00:00.000Z', monotonicMs: 1, type: 'operation-start', case: null, payload: { releaseId: '20260814T000000Z-r14-public-smoke-v2', matrix: ['chromium-immutable'] } });
  const second = ledger.append({ utc: '2026-08-14T00:00:00.001Z', monotonicMs: 2, type: 'operation-finish', case: null, payload: { caseCount: 1, screenshotCount: 3 } });

  assert.equal(first.seq, 1);
  assert.equal(first.previousEventSha256, '0'.repeat(64));
  assert.match(first.eventSha256, /^[a-f0-9]{64}$/);
  assert.equal(second.seq, 2);
  assert.equal(second.previousEventSha256, first.eventSha256);
  assert.notEqual(second.eventSha256, first.eventSha256);
  assert.deepEqual(ledger.records(), [first, second]);
});

test('deadlines admit values below the boundary and reject equality', () => {
  assert.equal(enforceStrictDeadline(119999.999, 120000, 'case.deadline'), 119999.999);
  assert.throws(() => enforceStrictDeadline(120000, 120000, 'case.deadline'), /case\.deadline/);
  assert.equal(enforceStrictDeadline(899999.999, 900000, 'operation.deadline'), 899999.999);
  assert.throws(() => enforceStrictDeadline(900000, 900000, 'operation.deadline'), /operation\.deadline/);
});

test('runCase drives the current product through the exact 38-input real UI journey', { timeout: 120000 }, async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const fixture = await startCurrentProductServer();
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'r14-task2-run-case-'));
  const ledger = createRunnerEventLedger();
  try {
    const result = await runner.runCase({
      browserType: chromium,
      engine: 'chromium',
      originKind: 'alias',
      originUrl: fixture.url,
      screenshotDir: path.join(tempRoot, 'screenshots'),
      eventLedger: ledger,
    });

    assert.doesNotThrow(() => validateTask2Case(result.observation));
    assert.equal(result.observation.actions.length, 38);
    assert.deepEqual(result.observation.intrusions.map(({ type }) => type), ['copilot', 'codex', 'gemini', 'ceo']);
    assert.deepEqual(result.observation.recoveries.map(({ after }) => after.stars), [2150, 2300, 2450, 2600, 2750, 2900, 3000]);
    assert.equal(result.observation.ending.initialFocusId, 'btn-play-again');
    assert.equal(result.observation.ending.tabFocusId, 'btn-play-again');
    assert.equal(result.observation.ending.shiftTabFocusId, 'btn-play-again');
    assert.equal(ledger.records().filter(({ type }) => type === 'trusted-input').length, 38);
    assert.equal(ledger.records().filter(({ type }) => type === 'screenshot-written').length, 3);
    result.observation.actions.slice(1).forEach((action, index) => assert.equal(action.preStateSha256, result.observation.actions[index].postStateSha256, `adjacent action ${index + 1}->${index + 2}`));
    const trustedEvents = ledger.records().filter(({ type }) => type === 'trusted-input');
    result.observation.actions.forEach((action, index) => assert.deepEqual(trustedEvents[index].payload, { actionSeq: action.seq, api: action.api, target: action.target, preStateSha256: action.preStateSha256, postStateSha256: action.postStateSha256, resultingUrl: action.resultingUrl }));
  } finally {
    await fixture.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('accepted publication writes manifest last and atomically renames an absent stage', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-publish-'));
  const acceptedDir = path.join(root, 'accepted');
  const stageDir = path.join(root, '.public-smoke-v2.stage-0123456789abcdef0123456789abcdef');
  try {
    await mkdir(stageDir);
    await writeFile(path.join(stageDir, 'runner-events.jsonl'), '{"seq":1}\n');
    await writeFile(path.join(stageDir, 'observations.json'), '[]\n');
    const manifest = await runner.publishAcceptedStage({
      stageDir,
      acceptedDir,
      releaseId: '20260814T000000Z-r14-public-smoke-v2',
    });

    await assert.rejects(access(stageDir));
    assert.equal(JSON.parse(await readFile(path.join(acceptedDir, 'artifact-manifest.json'), 'utf8')).manifestPayloadSha256, manifest.manifestPayloadSha256);
    assert.deepEqual(manifest.files.map(({ path: relative }) => relative), ['observations.json', 'runner-events.jsonl']);
    await assert.rejects(
      runner.publishAcceptedStage({ stageDir: acceptedDir, acceptedDir, releaseId: '20260814T000000Z-r14-public-smoke-v2' }),
      /publication\.acceptedAbsent/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed accepted work publishes diagnostics without a success manifest', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-failure-'));
  const stageDir = path.join(root, '.public-smoke-v2.stage-fedcba9876543210fedcba9876543210');
  try {
    await mkdir(stageDir);
    await writeFile(path.join(stageDir, 'diagnostic.txt'), 'case failed\n');
    const failureDir = await runner.publishFailureStage({ stageDir, failureRoot: root, basicUtc: '20260814T000000Z' });
    assert.match(path.basename(failureDir), /^public-smoke-v2-failure-20260814T000000Z-[a-f0-9]{32}$/);
    await assert.rejects(access(path.join(failureDir, 'artifact-manifest.json')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operation orders verifier, worker, accepted revalidation, then exclusive receipt', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  const trace = [];
  const result = await operation.orchestrateOperation({
    operationStartedMonotonicMs: 100,
    monotonicNow: () => 899_999,
    runVerifier: async () => { trace.push('verifier'); return { exitCode: 0, signal: null, stdout: 'R10_CAMPAIGN_GATE=VERIFIED\n', stderr: '' }; },
    runWorker: async () => { trace.push('worker'); return { exitCode: 0, signal: null, stdout: '', stderr: '' }; },
    revalidateAccepted: async () => { trace.push('revalidate'); return { eventCount: 278, screenshotBindings: Array.from({ length: 18 }, (_, index) => ({ index })) }; },
    publishReceipt: async (accepted) => { trace.push('receipt'); return { status: 'VERIFIED', accepted }; },
  });

  assert.deepEqual(trace, ['verifier', 'worker', 'revalidate', 'receipt']);
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.accepted.eventCount, 278);
});

test('operation never publishes a receipt after verifier, worker, or accepted validation failure', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  for (const failure of ['verifier', 'worker', 'accepted']) {
    let receiptCalls = 0;
    await assert.rejects(operation.orchestrateOperation({
      operationStartedMonotonicMs: 0,
      monotonicNow: () => 1,
      runVerifier: async () => ({ exitCode: failure === 'verifier' ? 1 : 0, signal: null, stdout: failure === 'verifier' ? '' : 'R10_CAMPAIGN_GATE=VERIFIED\n', stderr: '' }),
      runWorker: async () => ({ exitCode: failure === 'worker' ? 1 : 0, signal: null, stdout: '', stderr: '' }),
      revalidateAccepted: async () => { if (failure === 'accepted') throw new Error('accepted.invalid'); return { eventCount: 278, screenshotBindings: Array(18).fill({}) }; },
      publishReceipt: async () => { receiptCalls += 1; },
    }));
    assert.equal(receiptCalls, 0, `${failure} must not publish receipt`);
  }
});

test('runAcceptedSmoke produces exactly six ordered cases, 18 PNG bindings, and 278 chained events', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const ledger = createRunnerEventLedger();
  const calls = [];
  let clock = 10;
  const result = await runner.runAcceptedSmoke({
    releaseId: '20260814T000000Z-r14-public-smoke-v2',
    immutableUrl: 'https://01234567.penguin-exit-0.pages.dev/',
    aliasUrl: 'https://penguin-exit-0.pages.dev/',
    screenshotDir: 'unused-by-fixture',
    eventLedger: ledger,
    monotonicNow: () => ++clock,
    browserTypes: { chromium: 'chromium-fixture', firefox: 'firefox-fixture', webkit: 'webkit-fixture' },
    caseRunner: async ({ browserType, engine, originKind, originUrl, eventLedger }) => {
      const label = `${engine}-${originKind}`;
      calls.push({ label, browserType, originUrl, freshContextIdentity: Symbol(label) });
      eventLedger.append({ utc: '2026-08-14T00:00:00.000Z', monotonicMs: ++clock, type: 'case-start', case: label, payload: { engine, originKind, requestedUrl: originUrl } });
      for (let actionSeq = 1; actionSeq <= 38; actionSeq += 1) {
        eventLedger.append({ utc: '2026-08-14T00:00:00.000Z', monotonicMs: ++clock, type: 'trusted-input', case: label, payload: { actionSeq, api: 'locator.click', target: '#fixture', preStateSha256: '1'.repeat(64), postStateSha256: '2'.repeat(64), resultingUrl: originUrl } });
      }
      const screenshots = [];
      for (const stage of ['initial', 'progress', 'ending']) {
        const oracleSha256 = String(stage.length).repeat(64).slice(0, 64);
        const pngSha256 = String(stage.length + 1).repeat(64).slice(0, 64);
        const relativePath = `screenshots/${label}-${stage}.png`;
        eventLedger.append({ utc: '2026-08-14T00:00:00.000Z', monotonicMs: ++clock, type: 'screenshot-oracle', case: label, payload: { stage, oracleSha256 } });
        eventLedger.append({ utc: '2026-08-14T00:00:00.000Z', monotonicMs: ++clock, type: 'screenshot-written', case: label, payload: { stage, path: relativePath, pngSha256, oracleSha256 } });
        screenshots.push({ stage, relativePath });
      }
      eventLedger.append({ utc: '2026-08-14T00:00:00.000Z', monotonicMs: ++clock, type: 'case-finish', case: label, payload: { actionCount: 38, finalUrl: originUrl } });
      return { observation: { label, engine, originKind, attempt: 1, actions: Array(38).fill({}), screenshots } };
    },
  });

  assert.deepEqual(calls.map(({ label }) => label), ['chromium-immutable', 'chromium-alias', 'firefox-immutable', 'firefox-alias', 'webkit-immutable', 'webkit-alias']);
  assert.equal(new Set(calls.map(({ freshContextIdentity }) => freshContextIdentity)).size, 6);
  assert.deepEqual(calls.map(({ browserType }) => browserType), ['chromium-fixture', 'chromium-fixture', 'firefox-fixture', 'firefox-fixture', 'webkit-fixture', 'webkit-fixture']);
  assert.deepEqual(result.observations.map(({ attempt }) => attempt), [1, 1, 1, 1, 1, 1]);
  assert.equal(result.observations.flatMap(({ screenshots }) => screenshots).length, 18);
  assert.equal(result.events.length, 278);
  assert.deepEqual(result.events.map(({ seq }) => seq), Array.from({ length: 278 }, (_, index) => index + 1));
});

test('whole-operation deadline spans verifier start through worker finish and rejects equality', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  const exercise = (finished) => operation.orchestrateOperation({
    operationStartedMonotonicMs: 100,
    monotonicNow: () => finished,
    runVerifier: async () => ({ exitCode: 0, signal: null, stdout: 'R10_CAMPAIGN_GATE=VERIFIED\n', stderr: '' }),
    runWorker: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
    revalidateAccepted: async () => ({ eventCount: 278, screenshotBindings: Array(18).fill({}) }),
    publishReceipt: async () => ({ status: 'VERIFIED' }),
  });

  assert.equal((await exercise(900099.999)).status, 'VERIFIED');
  await assert.rejects(exercise(900100), /operation\.deadline/);
});

test('concrete operation CLI authenticates schema 2 config, exact verifier argv, worker capture, accepted reparse, and wx receipt', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-operation-'));
  const releaseRoot = path.join(root, 'release');
  const campaignDir = path.join(root, 'project', 'campaign');
  const sourceSnapshotDir = path.join(campaignDir, 'source');
  const executionSourceDir = path.join(root, 'project', 'execution');
  const configPath = path.join(root, 'operation.json');
  const file = (...parts) => path.join(...parts);
  try {
    await mkdir(file(sourceSnapshotDir, 'scripts'), { recursive: true });
    await mkdir(executionSourceDir, { recursive: true });
    await mkdir(releaseRoot, { recursive: true });
    const verifierPath = file(sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs');
    const runnerPath = file(sourceSnapshotDir, 'scripts', 'run-public-smoke-v2.mjs');
    await writeFile(verifierPath, '// verifier fixture\n');
    await writeFile(runnerPath, '// runner fixture\n');
    const config = {
      schemaVersion: 2,
      releaseId: '20260814T000000Z-r14-public-smoke-v2',
      releaseRoot,
      acceptedDir: file(releaseRoot, 'accepted'),
      failureRoot: file(releaseRoot, 'failures'),
      operationReceiptPath: file(releaseRoot, 'operation-receipt.json'),
      auditReceiptPath: file(releaseRoot, 'audit-receipt.json'),
      negativeReceiptPath: file(releaseRoot, 'negative-receipt.json'),
      closureRoot: file(releaseRoot, 'closure'),
      closureReceiptPath: file(releaseRoot, 'closure-receipt.json'),
      actualChromeEvidencePath: file(releaseRoot, 'actual-chrome.json'),
      releaseReceiptPath: file(releaseRoot, 'release-receipt.json'),
      workerStdoutPath: file(releaseRoot, 'worker.stdout.bin'),
      workerStderrPath: file(releaseRoot, 'worker.stderr.bin'),
      campaignDir,
      campaignSpecPath: file(root, 'campaign-spec.json'),
      campaignReceiptPath: file(root, 'campaign-receipt.json'),
      campaignRunId: '20260813T000000Z-r10-korean-release',
      sourceSnapshotDir,
      executionSourceDir,
      authorityProjectRoot: file(root, 'project'),
      authorityWorkspaceRoot: root,
      deploymentRecordPath: file(releaseRoot, 'deployment.json'),
      deploymentOperatorReceiptPath: file(releaseRoot, 'operator-deployment-receipt.json'),
      immutableUrl: 'https://01234567.penguin-exit-0.pages.dev/',
      aliasUrl: 'https://penguin-exit-0.pages.dev/',
      nodeExePath: await (await import('node:fs/promises')).realpath(process.execPath),
      nodeExeSha256: '1'.repeat(64),
      wranglerJsPath: file(root, 'wrangler.js'),
      wranglerJsSha256: '2'.repeat(64),
      projectName: 'penguin-exit-0',
      accountId: '0123456789abcdef0123456789abcdef',
      sourceGitTree: 'b'.repeat(40),
    };
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(config.auditReceiptPath, '');
    let blockedSpawnCalls = 0;
    await assert.rejects(operation.runOperationFromArgv(['--config', configPath], { spawnProcess: async () => { blockedSpawnCalls += 1; } }), /operation\.preflight\.auditReceiptPath/);
    assert.equal(blockedSpawnCalls, 0);
    await rm(config.auditReceiptPath);
    const calls = [];
    let semanticAuthentications = 0;
    const accepted = {
      eventCount: 278,
      screenshotBindings: ['chromium-immutable', 'chromium-alias', 'firefox-immutable', 'firefox-alias', 'webkit-immutable', 'webkit-alias'].flatMap((caseLabel) => ['initial', 'progress', 'ending'].map((stage) => ({ case: caseLabel, stage, path: `screenshots/${caseLabel}-${stage === 'ending' ? 'ending-640' : `${stage}-320`}.png`, pngSha256: '6'.repeat(64), oracleSha256: '7'.repeat(64), captureStartUtc: '2026-08-14T00:00:00.000Z', captureEndUtc: '2026-08-14T00:00:00.001Z' }))),
      accepted: { realpath: config.acceptedDir, manifestPath: path.join(config.acceptedDir, 'artifact-manifest.json'), manifestSha256: '3'.repeat(64), treeDigest: '3'.repeat(64), publishedUtc: '2026-08-14T00:00:00.000Z', eventsPath: path.join(config.acceptedDir, 'runner-events.jsonl'), eventsSha256: '3'.repeat(64), finalEventSha256: '3'.repeat(64) },
      cloudflareReads: Object.fromEntries(['pre', 'mid', 'post'].map((phase) => [phase, { capturePath: `control-plane/${phase}.command.json`, captureSha256: '4'.repeat(64), deploymentId: 'deployment-fixture' }])),
      fileProbes: { initialPath: 'file-probes/initial-10.json', initialSha256: '4'.repeat(64), initialPassed: 10, initialTotal: 10, finalAliasPath: 'file-probes/final-alias-5.json', finalAliasSha256: '5'.repeat(64), finalAliasPassed: 5, finalAliasTotal: 5 },
    };
    const result = await operation.runOperationFromArgv(['--config', configPath], {
      monotonicNow: (() => { let now = 100; return () => ++now; })(),
      utcNow: () => '2026-08-14T00:00:00.000Z',
      spawnProcess: async ({ argv, cwd, stdoutPath, stderrPath }) => {
        calls.push({ argv, cwd });
        const stdout = calls.length === 1 ? 'R10_CAMPAIGN_GATE=VERIFIED\n' : '';
        await writeFile(stdoutPath, stdout, { flag: 'wx' });
        await writeFile(stderrPath, '', { flag: 'wx' });
        return { exitCode: 0, signal: null };
      },
      revalidateAccepted: async (received) => {
        assert.equal(received.acceptedDir, config.acceptedDir);
        return accepted;
      },
      validateReceipt: (receipt) => validateOperationReceipt(receipt),
      authenticateAccepted: () => { semanticAuthentications += 1; },
      validatePreflightSeal: () => true,
    });

    assert.deepEqual(calls[0].argv, [
      config.nodeExePath, verifierPath,
      '--campaign', campaignDir,
      '--spec', config.campaignSpecPath,
      '--source', sourceSnapshotDir,
      '--execution-source', executionSourceDir,
      '--run', config.campaignRunId,
      '--authority-project', config.authorityProjectRoot,
      '--authority-workspace', config.authorityWorkspaceRoot,
    ]);
    assert.deepEqual(calls[1].argv, [config.nodeExePath, runnerPath, '--config', configPath]);
    assert.equal(result.status, 'VERIFIED');
    assert.equal(JSON.parse(await readFile(config.operationReceiptPath, 'utf8')).status, 'VERIFIED');
    assert.equal(semanticAuthentications, 1);
    assert.throws(() => validateOperationReceipt({ ...result, worker: { ...result.worker, finishedMonotonicMs: result.campaignVerifier.startedMonotonicMs + 900000 } }), /operationReceipt\.deadline/);
    await assert.rejects(operation.runOperationFromArgv(['--config', configPath], {
      monotonicNow: () => 1,
      utcNow: () => '2026-08-14T00:00:00.000Z',
      spawnProcess: async () => ({ exitCode: 0, signal: null }),
      revalidateAccepted: async () => accepted,
      validateReceipt: (receipt) => validateOperationReceipt(receipt),
      authenticateAccepted: () => true,
    }), /receipt|exist|EEXIST/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker CLI publishes accepted core artifacts from injected offline authority reads and exact smoke result', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-worker-'));
  const configPath = path.join(root, 'operation.json');
  const acceptedDir = path.join(root, 'accepted');
  const stageDir = path.join(root, '.stage');
  const events = Array.from({ length: 278 }, (_, index) => ({ seq: index + 1, eventSha256: String((index % 9) + 1).repeat(64) }));
  const observations = Array.from({ length: 6 }, (_, index) => ({
    label: ['chromium-immutable', 'chromium-alias', 'firefox-immutable', 'firefox-alias', 'webkit-immutable', 'webkit-alias'][index],
    screenshots: ['initial', 'progress', 'ending'].map((stage) => ({ stage, relativePath: `screenshots/case-${index}-${stage}.png` })),
  }));
  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2, releaseId: '20260814T000000Z-r14-public-smoke-v2', acceptedDir }));
    const protocol = [];
    const result = await runner.runWorkerFromArgv(['--config', configPath], {
      validateConfig: (value) => value,
      createStageDir: async () => { await mkdir(stageDir); return stageDir; },
      exchangePhase: async (phase) => {
        protocol.push(phase);
        if (phase === 'initial') {
          await mkdir(path.join(stageDir, 'control-plane'), { recursive: true });
          await mkdir(path.join(stageDir, 'file-probes', 'bodies'), { recursive: true });
          for (const controlPhase of ['pre', 'mid', 'post']) for (const suffix of ['command.json', 'stdout.bin', 'stderr.bin']) await writeFile(path.join(stageDir, 'control-plane', `${controlPhase}.${suffix}`), controlPhase);
          await writeFile(path.join(stageDir, 'file-probes', 'initial-10.json'), '{}');
          await writeFile(path.join(stageDir, 'file-probes', 'final-alias-5.json'), '{}');
          for (let index = 0; index < 15; index += 1) await writeFile(path.join(stageDir, 'file-probes', 'bodies', `${index}.bin`), String(index));
        }
        return phase === 'initial'
          ? { initialProbe: { passed: 10, total: 10, relativePath: 'file-probes/initial-10.json' }, controlPlane: { phase: 'pre', deploymentId: 'deployment-fixture' }, artifacts: [] }
          : phase === 'mid'
            ? { controlPlane: { phase: 'mid', deploymentId: 'deployment-fixture' }, artifacts: [] }
            : { controlPlane: { phase: 'post', deploymentId: 'deployment-fixture' }, finalProbe: { passed: 5, total: 5, relativePath: 'file-probes/final-alias-5.json' }, artifacts: [] };
      },
      runSmoke: async ({ onCaseFinished }) => {
        await onCaseFinished(3);
        await mkdir(path.join(stageDir, 'screenshots'), { recursive: true });
        for (const observation of observations) for (const screenshot of observation.screenshots) await writeFile(path.join(stageDir, ...screenshot.relativePath.split('/')), 'png-fixture');
        return { events, observations };
      },
      validateWorkerArtifacts: () => true,
    });
    assert.equal(result.eventCount, 278);
    assert.equal(JSON.parse(await readFile(path.join(acceptedDir, 'observations.json'), 'utf8')).length, 6);
    assert.equal((await readFile(path.join(acceptedDir, 'runner-events.jsonl'), 'utf8')).trim().split('\n').length, 278);
    assert.equal(JSON.parse(await readFile(path.join(acceptedDir, 'artifact-manifest.json'), 'utf8')).files.some(({ path: relative }) => relative === 'artifact-manifest.json'), false);
    assert.equal(JSON.parse(await readFile(path.join(acceptedDir, 'artifact-manifest.json'), 'utf8')).files.length, 47);
    assert.deepEqual(result.controlPlane.map(({ phase }) => phase), ['pre', 'mid', 'post']);
    assert.deepEqual(protocol, ['initial', 'mid', 'post']);
    assert.equal(result.initialProbe.relativePath, 'file-probes/initial-10.json');
    assert.equal(result.finalProbe.relativePath, 'file-probes/final-alias-5.json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker handshake failure publishes diagnostics only and never a success manifest', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-handshake-fail-'));
  const configPath = path.join(root, 'operation.json');
  const acceptedDir = path.join(root, 'accepted');
  const stageDir = path.join(root, '.stage');
  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2, releaseId: '20260814T000000Z-r14-public-smoke-v2', acceptedDir, failureRoot: root }));
    await assert.rejects(runner.runWorkerFromArgv(['--config', configPath], {
      validateConfig: (value) => value,
      createStageDir: async () => { await mkdir(stageDir); return stageDir; },
      exchangePhase: async () => { throw new Error('authority drift'); },
      runSmoke: async () => { throw new Error('must not reach cases'); },
    }), /authority drift/);
    await assert.rejects(access(acceptedDir));
    const failures = (await import('node:fs/promises')).readdir(root);
    const names = await failures;
    const failure = names.find((name) => name.startsWith('public-smoke-v2-failure-'));
    assert.ok(failure);
    await assert.rejects(access(path.join(root, failure, 'artifact-manifest.json')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker pauses the case matrix for outer initial/pre, mid, and post/final authority phases', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-phase-order-'));
  const configPath = path.join(root, 'operation.json');
  const stageDir = path.join(root, '.stage');
  const trace = [];
  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2, releaseId: '20260814T000000Z-r14-public-smoke-v2', acceptedDir: path.join(root, 'accepted'), failureRoot: root }));
    const events = Array.from({ length: 278 }, (_, index) => ({ seq: index + 1 }));
    const observations = Array.from({ length: 6 }, (_, index) => ({ label: String(index), screenshots: [{}, {}, {}] }));
    await runner.runWorkerFromArgv(['--config', configPath], {
      validateConfig: (value) => value,
      createStageDir: async () => { await mkdir(stageDir); return stageDir; },
      exchangePhase: async (phase) => {
        if (phase === 'initial') trace.push('initial-probe', 'pre');
        else if (phase === 'post') trace.push('post', 'final-probe');
        else trace.push(phase);
        return { initialProbe: {}, finalProbe: {}, controlPlane: { phase: phase === 'initial' ? 'pre' : phase } };
      },
      runSmoke: async ({ onCaseFinished }) => {
        for (let index = 1; index <= 6; index += 1) {
          trace.push(`case-${index}`);
          await onCaseFinished(index);
        }
        return { events, observations };
      },
      validateWorkerArtifacts: () => true,
    });
    assert.deepEqual(trace, ['initial-probe', 'pre', 'case-1', 'case-2', 'case-3', 'mid', 'case-4', 'case-5', 'case-6', 'post', 'final-probe']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('active deadline cancels work instead of checking only after return', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  let cancelled = 0;
  await assert.rejects(runner.enforceActiveDeadline(new Promise(() => {}), 20, 'case.deadline', () => { cancelled += 1; }), /case\.deadline/);
  assert.equal(cancelled, 1);
});

test('failure publication creates an absent failure root before atomic rename', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-absent-failure-'));
  const stageDir = path.join(root, '.stage');
  const failureRoot = path.join(root, 'missing', 'failures');
  try {
    await mkdir(stageDir);
    await writeFile(path.join(stageDir, 'diagnostic.txt'), 'failure');
    const failure = await runner.publishFailureStage({ stageDir, failureRoot, basicUtc: '20260814T000000Z' });
    assert.equal(path.dirname(failure), failureRoot);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('spawned worker transport rejects wrong IPC phase and actively kills timeout', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-spawn-'));
  const childPath = path.join(root, 'child.mjs');
  try {
    await writeFile(childPath, "process.send({type:'READY_MID',stageDir:process.cwd()}); setInterval(()=>{},1000);");
    const wrong = await operation.spawnCapturedProcess({ argv: [process.execPath, childPath], cwd: root, stdoutPath: path.join(root, 'wrong.out'), stderrPath: path.join(root, 'wrong.err'), timeoutMs: 1000, phaseAuthority: async () => ({}) });
    assert.notEqual(wrong.signal, null);
    await writeFile(childPath, 'setInterval(()=>{},1000);');
    const timed = await operation.spawnCapturedProcess({ argv: [process.execPath, childPath], cwd: root, stdoutPath: path.join(root, 'time.out'), stderrPath: path.join(root, 'time.err'), timeoutMs: 30 });
    assert.notEqual(timed.signal, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('outer IPC owner pins INITIAL stage identity and moves it once on MID drift or timeout', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-outer-cleanup-'));
  const releaseRoot = path.join(root, 'release');
  const failureRoot = path.join(releaseRoot, 'failures');
  const stage = path.join(releaseRoot, `.public-smoke-v2.stage-${'a'.repeat(32)}`);
  const drift = path.join(releaseRoot, `.public-smoke-v2.stage-${'b'.repeat(32)}`);
  const childPath = path.join(root, 'child.mjs');
  try {
    await mkdir(stage, { recursive: true }); await mkdir(drift);
    await writeFile(path.join(stage, 'diagnostic.txt'), 'owned');
    await writeFile(childPath, `process.send({type:'READY_INITIAL',stageDir:${JSON.stringify(stage)}}); process.once('message',()=>process.send({type:'READY_MID',stageDir:${JSON.stringify(drift)}})); setInterval(()=>{},1000);`);
    const result = await operation.spawnCapturedProcess({ argv: [process.execPath, childPath], cwd: root, stdoutPath: path.join(root, 'drift.out'), stderrPath: path.join(root, 'drift.err'), timeoutMs: 1000, releaseRoot, failureRoot, phaseAuthority: async () => ({}) });
    assert.notEqual(result.signal, null);
    await assert.rejects(access(stage));
    assert.equal((await (await import('node:fs/promises')).readdir(failureRoot)).length, 1);
    assert.equal(await readFile(path.join(failureRoot, (await (await import('node:fs/promises')).readdir(failureRoot))[0], 'diagnostic.txt'), 'utf8'), 'owned');
    assert.equal((await (await import('node:fs/promises')).readdir(releaseRoot)).filter((name) => name.startsWith('failure-')).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('outer IPC owner never renames an untrusted INITIAL stage outside the release boundary', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-untrusted-stage-'));
  const releaseRoot = path.join(root, 'release'); const failureRoot = path.join(releaseRoot, 'failures');
  const hostile = path.join(root, `.public-smoke-v2.stage-${'c'.repeat(32)}`); const childPath = path.join(root, 'child.mjs');
  try {
    await mkdir(releaseRoot); await mkdir(hostile); await writeFile(path.join(hostile, 'sentinel.txt'), 'preserve');
    await writeFile(childPath, `process.send({type:'READY_INITIAL',stageDir:${JSON.stringify(hostile)}}); setInterval(()=>{},1000);`);
    const result = await operation.spawnCapturedProcess({ argv: [process.execPath, childPath], cwd: root, stdoutPath: path.join(root, 'hostile.out'), stderrPath: path.join(root, 'hostile.err'), timeoutMs: 200, releaseRoot, failureRoot, phaseAuthority: async () => ({}) });
    assert.notEqual(result.signal, null);
    assert.equal(await readFile(path.join(hostile, 'sentinel.txt'), 'utf8'), 'preserve');
    await assert.rejects(access(failureRoot));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('probe collectors publish the exact schema filenames and cardinality identity', async () => {
  const runnerSource = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8');
  assert.match(runnerSource, /file-probes\/initial-10\.json/);
  assert.match(runnerSource, /file-probes\/final-alias-5\.json/);
});

test('initial collector writes and returns the real 10-result probe artifact', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture').pathname;
    const mime = pathname === '/' ? 'text/html' : pathname.endsWith('.css') ? 'text/css' : 'application/javascript';
    response.writeHead(200, { 'content-type': mime, 'content-length': 3 }); response.end('abc');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-probe-real-'));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const productFiles = Object.fromEntries(['/', '/content.js', '/game-core.js', '/script.js', '/style.css'].map((publicPath) => [publicPath, { bytes: 3, mime: publicPath === '/' ? 'text/html' : publicPath.endsWith('.css') ? 'text/css' : 'application/javascript', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }]));
  try {
    const probe = await runner.collectInitialProbe({ config: { immutableUrl: url, aliasUrl: url }, stageDir: root, authority: { deployment: { deploymentId: 'dep', immutableUrl: url }, sourceGitHead: 'a'.repeat(40), productFiles } });
    assert.equal(probe.relativePath, 'file-probes/initial-10.json');
    assert.equal(probe.passed, 10); assert.equal(probe.total, 10); assert.equal(probe.results.length, 10);
    assert.equal(JSON.parse(await readFile(path.join(root, 'file-probes', 'initial-10.json'), 'utf8')).results.length, 10);
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('outer authority rejects hostile Wrangler rows and public probe MIME, bytes, SHA, URL, source, and deployment drift before ACK', async () => {
  const lib = await import('../../scripts/public-smoke-v2-lib.mjs');
  const authority = { deploymentId: 'dep', immutableUrl: 'https://abc.pages.dev/', sourceGitHead: 'a'.repeat(40), product: { bytes: 3, mime: 'text/html', sha256: 'b'.repeat(64) } };
  const row = { Id: 'dep', Environment: 'Production', Branch: 'main', Source: 'aaaaaaa', Deployment: authority.immutableUrl, Status: 'success', Build: 'ok' };
  assert.doesNotThrow(() => lib.validateOuterAuthority({ row, result: { requestedUrl: authority.immutableUrl, finalUrl: authority.immutableUrl, status: 200, mime: 'text/html', bytes: 3, sha256: 'b'.repeat(64), redirects: [] }, authority }));
  for (const [label, mutation] of [
    ['Id', { row: { ...row, Id: 'other' } }], ['Environment', { row: { ...row, Environment: 'Preview' } }], ['Branch', { row: { ...row, Branch: 'dev' } }], ['Source', { row: { ...row, Source: 'bbbbbbb' } }], ['Deployment', { row: { ...row, Deployment: 'https://other.pages.dev/' } }], ['unknown key', { row: { ...row, Extra: 'x' } }],
    ['MIME', { result: { mime: 'text/plain' } }], ['bytes', { result: { bytes: 4 } }], ['SHA', { result: { sha256: 'c'.repeat(64) } }], ['finalUrl', { result: { finalUrl: 'https://evil.invalid/' } }], ['redirect', { result: { redirects: [{}] } }],
  ]) assert.throws(() => lib.validateOuterAuthority({ row: mutation.row ?? row, result: { requestedUrl: authority.immutableUrl, finalUrl: authority.immutableUrl, status: 200, mime: 'text/html', bytes: 3, sha256: 'b'.repeat(64), redirects: [], ...mutation.result }, authority }), /authority/, label);
});

test('runner derives ending tokens and resolution accessible names from allowed DOM probes', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8');
  assert.doesNotMatch(source, /tokens:\s*\['PROCESS EXIT CODE/);
  assert.doesNotMatch(source, /ordinal === 0 \? '페널티 수락/);
  assert.match(source, /endingDocument\.ending\.tokens/);
  assert.match(source, /intrusionDocument\.controls/);
});

test('orchestrator binding accepts different canonical execution/snapshot paths only for equal bytes', async () => {
  const lib = await import('../../scripts/public-smoke-v2-lib.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-binding-'));
  try {
    const executed = path.join(root, 'worktree.mjs');
    const snapshot = path.join(root, 'snapshot.mjs');
    await writeFile(executed, 'same\n'); await writeFile(snapshot, 'same\n');
    assert.doesNotThrow(() => lib.validateExecutedSnapshotBinding(executed, snapshot));
    await writeFile(snapshot, 'drift\n');
    assert.throws(() => lib.validateExecutedSnapshotBinding(executed, snapshot), /scriptBinding/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [label, source] of [
  ['timer application call', 'setTimeout(() => application.advance(), 0)'],
  ['named probe window call', 'export async function readDocumentSnapshot(page) { return page.evaluate(() => window.advanceGame()); }'],
  ['named probe dataset assignment', "export async function readDocumentSnapshot(page) { return page.evaluate(() => { document.body.dataset.forged = '1'; }); }"],
  ['named probe DOM property assignment', 'export async function readDocumentSnapshot(page) { return page.evaluate(() => { const node = document.body; node.disabled = false; }); }'],
]) test(`callback AST default-deny rejects ${label}`, () => assert.throws(() => validateRunnerSourcePolicy(source), /runner\.policy/));

test('callback AST permits callback-local primitive assignment', () => {
  assert.doesNotThrow(() => validateRunnerSourcePolicy('export async function readDocumentSnapshot(page) { return page.evaluate(() => { const count = 1; let total = count; total += 1; return total; }); }'));
});

function validFairPingFixture() {
  const command = 'archon@stone-igloo:~$ ping 8.8.8.8';
  const system = '64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=14.2 ms\n케이블이 빠져 있었습니다. 네트워크를 복구했습니다.';
  const roast = '아콘 🐧 // 지식은 레버리지가 아니다 애송아.';
  return {
    command, commandKind: 'command', system, systemKind: 'system', roast, roastKind: 'archon',
    provenance: { beforeRowCount: 3, rows: [
      { text: command, kind: 'command', context: '', index: '', pseudoLabel: 'none' },
      { text: system, kind: 'system', context: '', index: '', pseudoLabel: 'none' },
      { text: roast, kind: 'archon', context: 'puzzle', index: '1', pseudoLabel: '"ARCHON // ROAST"' },
    ] },
  };
}

function validTask2SignatureFixture() {
  return {
    command: 'archon@stone-igloo:~$ systemctl restart nginx', commandKind: 'command',
    system: 'Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.', systemKind: 'system',
    roast: '아콘 🐧 // 내 할머니도 너보단 코딩을 잘하겠다.', roastKind: 'archon', pseudoLabel: '"ARCHON // ROAST"',
    tabs: { wifiAriaSelected: 'false', wifiTabIndex: '-1', cpuAriaSelected: 'true', cpuTabIndex: '0', panelAriaLabelledby: 'tab-cpu', terminalRowsPersisted: true },
    fairPing: validFairPingFixture(),
  };
}

function negativeBeforeRowCountObservations() {
  const signature = validTask2SignatureFixture();
  signature.fairPing.provenance.beforeRowCount = -1;
  return Array.from({ length: 6 }, () => ({ signature: structuredClone(signature) }));
}

test('Task2 rejects negative fairPing beforeRowCount in direct observation validation', async () => {
  const lib = await import('../../scripts/public-smoke-v2-lib.mjs');
  assert.throws(() => lib.validateTask2FairPingObservations(negativeBeforeRowCountObservations()), /fairPing\.provenance\.beforeRowCount/);
});

test('Task2 rejects negative fairPing beforeRowCount before worker accepted publication', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-negative-before-row-worker-'));
  const configPath = path.join(root, 'operation.json'); const acceptedDir = path.join(root, 'accepted'); const failureRoot = path.join(root, 'failures'); const stageDir = path.join(root, `.public-smoke-v2.stage-${'8'.repeat(32)}`);
  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2, releaseId: '20260814T000000Z-r14-public-smoke-v2', acceptedDir, failureRoot }));
    await assert.rejects(runner.runWorkerFromArgv(['--config', configPath], {
      validateConfig: (value) => value,
      createStageDir: async () => { await mkdir(stageDir, { recursive: true }); return stageDir; },
      exchangePhase: async (phase) => ({ initialProbe: {}, finalProbe: {}, controlPlane: { phase: phase === 'initial' ? 'pre' : phase } }),
      runSmoke: async ({ onCaseFinished }) => { await onCaseFinished(3); return { observations: negativeBeforeRowCountObservations(), events: Array(278).fill({}) }; },
    }), /fairPing\.provenance\.beforeRowCount/);
    await assert.rejects(access(acceptedDir));
    const failures = await (await import('node:fs/promises')).readdir(failureRoot); assert.equal(failures.length, 1);
    await assert.rejects(access(path.join(failureRoot, failures[0], 'artifact-manifest.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Task2 rejects negative fairPing beforeRowCount after full outer reseal and before audit or receipt', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs'); const lib = await import('../../scripts/public-smoke-v2-lib.mjs'); const { createHash } = await import('node:crypto');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-negative-before-row-operation-')); const acceptedDir = path.join(root, 'accepted'); const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  try {
    await mkdir(acceptedDir); const observationsPath = path.join(acceptedDir, 'observations.json'); const observations = negativeBeforeRowCountObservations();
    await writeFile(observationsPath, `${lib.canonicalJson(observations)}\n`);
    const observationBytes = await readFile(observationsPath); const manifestPayload = { schemaVersion: 1, releaseId: '20260814T000000Z-r14-public-smoke-v2', files: [{ path: 'observations.json', bytes: observationBytes.length, sha256: sha(observationBytes) }] };
    const manifest = { ...manifestPayload, manifestPayloadSha256: sha(lib.canonicalJson(manifestPayload)) }; const manifestPath = path.join(acceptedDir, 'artifact-manifest.json'); await writeFile(manifestPath, `${lib.canonicalJson(manifest)}\n`);
    const manifestSha256 = sha(await readFile(manifestPath)); const receipt = { accepted: { manifestSha256, treeDigest: sha(lib.canonicalJson({ files: manifest.files, manifestSha256 })) } }; let audits = 0;
    await assert.rejects(operation.authenticateTask2Accepted({ acceptedDir, operationReceipt: receipt, auditAccepted: () => { audits += 1; } }), /fairPing\.provenance\.beforeRowCount/);
    assert.equal(audits, 0); await assert.rejects(access(path.join(root, 'operation-receipt.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fair signature exact primitive rejects independent one-character command, system, and roast drift', () => {
  const task2Signature = {
    command: 'archon@stone-igloo:~$ systemctl restart nginx', commandKind: 'command',
    system: 'Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.', systemKind: 'system',
    roast: '아콘 🐧 // 내 할머니도 너보단 코딩을 잘하겠다.', roastKind: 'archon', pseudoLabel: '"ARCHON // ROAST"',
    tabs: { wifiAriaSelected: 'false', wifiTabIndex: '-1', cpuAriaSelected: 'true', cpuTabIndex: '0', panelAriaLabelledby: 'tab-cpu', terminalRowsPersisted: true }, fairPing: validFairPingFixture(),
  };
  const { fairPing, ...legacySignature } = task2Signature;
  assert.doesNotThrow(() => validateSignature(legacySignature));
  assert.throws(() => validateSignature(task2Signature), /signature/);
  for (const key of ['command', 'system', 'roast']) assert.throws(() => validateSignature({ ...legacySignature, [key]: `${legacySignature[key]}x` }), new RegExp(`signature\\.${key}`), key);
});

test('Task2 contextual signature accepts exact fairPing provenance without widening generic signature', async () => {
  const lib = await import('../../scripts/public-smoke-v2-lib.mjs');
  const signature = {
    command: 'archon@stone-igloo:~$ systemctl restart nginx', commandKind: 'command',
    system: 'Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.', systemKind: 'system',
    roast: '아콘 🐧 // 내 할머니도 너보단 코딩을 잘하겠다.', roastKind: 'archon', pseudoLabel: '"ARCHON // ROAST"',
    tabs: { wifiAriaSelected: 'false', wifiTabIndex: '-1', cpuAriaSelected: 'true', cpuTabIndex: '0', panelAriaLabelledby: 'tab-cpu', terminalRowsPersisted: true }, fairPing: validFairPingFixture(),
  };
  assert.doesNotThrow(() => lib.validateTask2FairPingObservations(Array.from({ length: 6 }, () => ({ signature }))));
});

test('actual verifier CLI accepts authenticated Task2 profile and publishes one receipt-bound gate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-actual-verifier-')); const copiedTest = path.join(root, 'actual-verifier-fixture.test.mjs');
  try {
    const contractPath = path.join(projectRoot, 'tests', 'harness', 'public-smoke-v2-contract.test.js');
    let source = await readFile(contractPath, 'utf8');
    const libraryUrl = new URL('scripts/public-smoke-v2-lib.mjs', new URL(`file:///${projectRoot.replaceAll('\\', '/')}/`)).href;
    source = source.replaceAll("from '../../scripts/public-smoke-v2-lib.mjs'", `from ${JSON.stringify(libraryUrl)}`);
    const verifierPath = path.join(projectRoot, 'scripts', 'verify-public-smoke-v2.mjs');
    const hostileBeforeRowCount = process.env.R14_TEST_NEGATIVE_BEFORE_ROW_COUNT === '1';
    const verifierAssertions = hostileBeforeRowCount
      ? "assert.equal(result.status,1,JSON.stringify({status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr,auditReceiptExists:fs.existsSync(fixture.config.auditReceiptPath)})); assert.equal(result.signal,null); assert.equal(result.stdout,''); assert.match(result.stderr,/fairPing\\.provenance\\.beforeRowCount/); assert.equal(fs.existsSync(fixture.config.auditReceiptPath),false);"
      : "assert.equal(result.status,0,JSON.stringify({status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr,auditReceiptExists:fs.existsSync(fixture.config.auditReceiptPath)})); assert.equal(result.signal,null); assert.equal(result.stderr,''); assert.match(result.stdout,/^PUBLIC_SMOKE_V2_GATE=6\\/6 manifest_sha256=[0-9a-f]{64} release=20260813T010203Z-r14-public-smoke-v2\\n$/); assert.equal(result.stdout.split('PUBLIC_SMOKE_V2_GATE=').length-1,1); assert.equal(fs.existsSync(fixture.config.auditReceiptPath),true); smoke.validateAuditReceipt(readJson(fixture.config.auditReceiptPath));";
    source += `\n test('actual verifier Task2 fixture', (t) => { const fixture=createAcceptedFixture(t); const observations=structuredClone(fixture.cases); const fair={command:'archon@stone-igloo:~$ ping 8.8.8.8',commandKind:'command',system:'64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=14.2 ms\\n케이블이 빠져 있었습니다. 네트워크를 복구했습니다.',systemKind:'system',roast:'아콘 🐧 // 지식은 레버리지가 아니다 애송아.',roastKind:'archon',provenance:{beforeRowCount:${hostileBeforeRowCount ? -1 : 3},rows:[{text:'archon@stone-igloo:~$ ping 8.8.8.8',kind:'command',context:'',index:'',pseudoLabel:'none'},{text:'64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=14.2 ms\\n케이블이 빠져 있었습니다. 네트워크를 복구했습니다.',kind:'system',context:'',index:'',pseudoLabel:'none'},{text:'아콘 🐧 // 지식은 레버리지가 아니다 애송아.',kind:'archon',context:'puzzle',index:'1',pseudoLabel:'\"ARCHON // ROAST\"'}]}}; observations.forEach((record)=>{record.signature.fairPing=fair;}); const acceptedPath=path.join(fixture.acceptedDir,'accepted-run.json'); const accepted=readJson(acceptedPath); accepted.tooling.runner.version='2'; accepted.tooling.library.version='2'; writeJson(path.join(fixture.sourceSnapshot,'package.json'),{devDependencies:{'@playwright/test':'1.62.1'}}); const inventory=walkInventory(fixture.sourceSnapshot); writeJson(path.join(fixture.campaignDir,'candidate-inventory.json'),inventory); const claims=readJson(path.join(fixture.campaignDir,'claims.json')); claims.candidateInventory={fileCount:inventory.fileCount,pathListSha256:inventory.pathListSha256,contentRecordsSha256:inventory.contentRecordsSha256}; writeJson(path.join(fixture.campaignDir,'claims.json'),claims); const envelope=readJson(path.join(fixture.campaignDir,'submission-envelope.json')); envelope.payloadHashes['candidate-inventory.json']=sha256File(path.join(fixture.campaignDir,'candidate-inventory.json')); envelope.payloadHashes['claims.json']=sha256File(path.join(fixture.campaignDir,'claims.json')); envelope.source={...envelope.source,fileCount:inventory.fileCount,pathListSha256:inventory.pathListSha256,contentRecordsSha256:inventory.contentRecordsSha256}; writeJson(path.join(fixture.campaignDir,'submission-envelope.json'),envelope); const campaignReceipt=readJson(fixture.campaignReceiptPath); campaignReceipt.candidateInventory=claims.candidateInventory; campaignReceipt.campaign.submissionEnvelopeSha256=sha256File(path.join(fixture.campaignDir,'submission-envelope.json')); writeJson(fixture.campaignReceiptPath,campaignReceipt); const playwright=smoke.resolvePlaywrightAuthority(fixture.sourceSnapshot); accepted.tooling.playwright={path:playwright.path,version:playwright.version,sha256:playwright.sha256}; writeJson(acceptedPath,accepted); rewriteAccepted(fixture,{observations}); const operation=readJson(fixture.operationReceiptPath); operation.accepted.manifestSha256=sha256File(path.join(fixture.acceptedDir,'artifact-manifest.json')); operation.accepted.treeDigest=sha256(canonicalJson({files:fixture.manifest.files,manifestSha256:operation.accepted.manifestSha256})); writeJson(fixture.operationReceiptPath,operation); const result=spawnSync(process.execPath,[${JSON.stringify(verifierPath)},'--config',fixture.configPath],{cwd:${JSON.stringify(projectRoot)},encoding:'utf8',windowsHide:true,shell:false}); ${verifierAssertions} });\n`;
    source += `
function prepareActualVerifierTask2Fixture(t, mutate) {
  const fixture=createAcceptedFixture(t); const observations=structuredClone(fixture.cases);
  const fair={command:'archon@stone-igloo:~$ ping 8.8.8.8',commandKind:'command',system:'64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=14.2 ms\\n케이블이 빠져 있었습니다. 네트워크를 복구했습니다.',systemKind:'system',roast:'아콘 🐧 // 지식은 레버리지가 아니다 애송아.',roastKind:'archon',provenance:{beforeRowCount:3,rows:[{text:'archon@stone-igloo:~$ ping 8.8.8.8',kind:'command',context:'',index:'',pseudoLabel:'none'},{text:'64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=14.2 ms\\n케이블이 빠져 있었습니다. 네트워크를 복구했습니다.',kind:'system',context:'',index:'',pseudoLabel:'none'},{text:'아콘 🐧 // 지식은 레버리지가 아니다 애송아.',kind:'archon',context:'puzzle',index:'1',pseudoLabel:'\"ARCHON // ROAST\"'}]}};
  observations.forEach((record)=>{record.signature.fairPing=structuredClone(fair);}); const acceptedPath=path.join(fixture.acceptedDir,'accepted-run.json'); const accepted=readJson(acceptedPath); accepted.tooling.runner.version='2'; accepted.tooling.library.version='2';
  writeJson(path.join(fixture.sourceSnapshot,'package.json'),{devDependencies:{'@playwright/test':'1.62.1'}}); const inventory=walkInventory(fixture.sourceSnapshot); writeJson(path.join(fixture.campaignDir,'candidate-inventory.json'),inventory); const claims=readJson(path.join(fixture.campaignDir,'claims.json')); claims.candidateInventory={fileCount:inventory.fileCount,pathListSha256:inventory.pathListSha256,contentRecordsSha256:inventory.contentRecordsSha256}; writeJson(path.join(fixture.campaignDir,'claims.json'),claims); const envelope=readJson(path.join(fixture.campaignDir,'submission-envelope.json')); envelope.payloadHashes['candidate-inventory.json']=sha256File(path.join(fixture.campaignDir,'candidate-inventory.json')); envelope.payloadHashes['claims.json']=sha256File(path.join(fixture.campaignDir,'claims.json')); envelope.source={...envelope.source,fileCount:inventory.fileCount,pathListSha256:inventory.pathListSha256,contentRecordsSha256:inventory.contentRecordsSha256}; writeJson(path.join(fixture.campaignDir,'submission-envelope.json'),envelope); const campaignReceipt=readJson(fixture.campaignReceiptPath); campaignReceipt.candidateInventory=claims.candidateInventory; campaignReceipt.campaign.submissionEnvelopeSha256=sha256File(path.join(fixture.campaignDir,'submission-envelope.json')); writeJson(fixture.campaignReceiptPath,campaignReceipt);
  const playwright=smoke.resolvePlaywrightAuthority(fixture.sourceSnapshot); accepted.tooling.playwright={path:playwright.path,version:playwright.version,sha256:playwright.sha256}; mutate({fixture,observations,accepted}); writeJson(acceptedPath,accepted); rewriteAccepted(fixture,{observations}); const operation=readJson(fixture.operationReceiptPath); operation.accepted.manifestSha256=sha256File(path.join(fixture.acceptedDir,'artifact-manifest.json')); operation.accepted.treeDigest=sha256(canonicalJson({files:fixture.manifest.files,manifestSha256:operation.accepted.manifestSha256})); writeJson(fixture.operationReceiptPath,operation); return fixture;
}
for (const [label,expected,mutate] of [
  ['missing fairPing',/task2\\.fairPing\\.provenance/,({observations})=>observations.forEach((record)=>delete record.signature.fairPing)],
  ['fairPing provenance row-kind drift',/task2\\.fairPing\\.provenance/,({observations})=>{observations[0].signature.fairPing.provenance.rows[1].kind='command';}],
  ['legacy marker with fairPing',/signature/,({accepted})=>{accepted.tooling.runner.version='1';accepted.tooling.library.version='1';}],
  ['runner 1 library 2',/acceptedRun\\.tooling\\.profile/,({accepted})=>{accepted.tooling.runner.version='1';}],
  ['runner 2 library 1',/acceptedRun\\.tooling\\.profile/,({accepted})=>{accepted.tooling.library.version='1';}],
  ['unknown version pair',/acceptedRun\\.tooling\\.profile/,({accepted})=>{accepted.tooling.runner.version='3';accepted.tooling.library.version='3';}],
  ['runner path drift',/acceptedRun\\.tooling\\.profile/,({fixture,accepted})=>{accepted.tooling.runner.path='scripts/run-public-smoke-v2-operation.mjs';accepted.tooling.runner.sha256=sha256File(path.join(fixture.sourceSnapshot,accepted.tooling.runner.path));}],
  ['playwright declaration drift',/playwrightAuthority\\.declaration/,({accepted})=>{accepted.tooling.playwright.sha256=accepted.tooling.playwright.sha256.replace(/^./,accepted.tooling.playwright.sha256[0]==='0'?'1':'0');}],
]) test('actual verifier Task2 rejects '+label+' without gate or receipt',(t)=>{const fixture=prepareActualVerifierTask2Fixture(t,mutate);const result=spawnSync(process.execPath,[${JSON.stringify(verifierPath)},'--config',fixture.configPath],{cwd:${JSON.stringify(projectRoot)},encoding:'utf8',windowsHide:true,shell:false});assert.equal(result.status,1,JSON.stringify({status:result.status,stdout:result.stdout,stderr:result.stderr}));assert.equal(result.signal,null);assert.equal(result.stdout,'');assert.match(result.stderr,expected);assert.equal(fs.existsSync(fixture.config.auditReceiptPath),false);});
`;
    await writeFile(copiedTest, source);
    const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID'].includes(key)));
    const { spawnSync } = await import('node:child_process'); const result = spawnSync(process.execPath, ['--test', '--test-name-pattern', 'actual verifier Task2', '--test-reporter', 'tap', copiedTest], { encoding: 'utf8', env: childEnvironment });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /# tests 9\n/);
    assert.match(result.stdout, /# pass 9\n/);
    assert.match(result.stdout, /# fail 0\n/);
    assert.equal(result.stderr, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Task2 rejects negative fairPing beforeRowCount in the fully resealed actual verifier CLI', async () => {
  const { spawnSync } = await import('node:child_process');
  const testPath = fileURLToPath(import.meta.url);
  const environment = { ...process.env, R14_TEST_NEGATIVE_BEFORE_ROW_COUNT: '1' };
  delete environment.NODE_TEST_CONTEXT; delete environment.NODE_TEST_WORKER_ID;
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern', 'actual verifier CLI accepts authenticated Task2 profile', '--test-reporter', 'tap', testPath], { cwd: projectRoot, encoding: 'utf8', env: environment, windowsHide: true, shell: false });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# tests 1\n/); assert.match(result.stdout, /# pass 1\n/); assert.match(result.stdout, /# fail 0\n/); assert.equal(result.stderr, '');
});

test('fair signature is assembled from readDocumentSnapshot rows in the current-product journey', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8');
  assert.match(source, /const signatureDocument = await readDocumentSnapshot\(page\)/);
  assert.match(source, /command: commandRow\?\.text/);
  assert.match(source, /system: systemRow\?\.text/);
  assert.match(source, /roast: roastRow\?\.text/);
});

test('readDocumentSnapshot emits an explicit exact fair signature primitive', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<div id="terminal-output">
      <div class="terminal-line" data-terminal-kind="command">archon@stone-igloo:~$ systemctl restart nginx</div>
      <div class="terminal-line" data-terminal-kind="system">Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.</div>
      <div class="terminal-line" data-terminal-kind="archon" data-dialogue-context="puzzle" data-dialogue-index="0">아콘 🐧 // 내 할머니도 너보단 코딩을 잘하겠다.</div>
    </div>`);
    const snapshot = await runner.readDocumentSnapshot(page);
    assert.deepEqual(snapshot.fairSignature, {
      command: 'archon@stone-igloo:~$ systemctl restart nginx', commandKind: 'command',
      system: 'Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.', systemKind: 'system',
      roast: '아콘 🐧 // 내 할머니도 너보단 코딩을 잘하겠다.', roastKind: 'archon', pseudoLabel: 'none',
    });
  } finally { await browser.close(); }
});

test('one-shot preflight rejects every existing success output including zero-byte files', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-preflight-'));
  const keys = ['acceptedDir', 'operationReceiptPath', 'auditReceiptPath', 'negativeReceiptPath', 'closureRoot', 'closureReceiptPath', 'actualChromeEvidencePath', 'releaseReceiptPath', 'workerStdoutPath', 'workerStderrPath'];
  try {
    const config = Object.fromEntries(keys.map((key) => [key, path.join(root, key)]));
    for (const key of keys) {
      const target = config[key];
      if (key.endsWith('Dir') || key.endsWith('Root')) await mkdir(target);
      else await writeFile(target, '');
      assert.throws(() => operation.assertOperationOutputsAbsent(config), new RegExp(`operation\\.preflight\\.${key}`), key);
      await rm(target, { recursive: true, force: true });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [label, source] of [
  ['destructured setter', 'const { setAttribute: write } = node; write("style", "display:none")'],
  ['alias mutation', 'const write = node.setAttribute.bind(node); write("style", "display:none")'],
  ['Reflect.apply', 'Reflect.apply(node.setAttribute, node, ["style", "display:none"])'],
  ['Object.assign', 'Object.assign(node, { hidden: true })'],
  ['Reflect.set', 'Reflect.set(node, "disabled", false)'],
  ['Object.defineProperty', 'Object.defineProperty(node, "textContent", { value: "forged" })'],
]) test(`callback policy rejects reviewer ${label} attack`, () => assert.throws(() => validateRunnerSourcePolicy(source), /runner\.policy/));

test('operation preflight applies callback policy before verifier, worker, or phase authority', async () => {
  const operationSource = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2-operation.mjs'), 'utf8');
  assert.match(operationSource, /validateRunnerSourcePolicy/);
  assert.match(operationSource, /assertOperationOutputsAbsent[\s\S]*validateRunnerSourcePolicy[\s\S]*runVerifier|validateRunnerSourcePolicy[\s\S]*const verifier/);
});

test('fair ping primitive rejects independent one-character text and kind drift', async () => {
  const lib = await import('../../scripts/public-smoke-v2-lib.mjs');
  const fair = validFairPingFixture();
  assert.doesNotThrow(() => lib.validateFairPing(fair));
  for (const key of ['command', 'system', 'roast', 'commandKind', 'systemKind', 'roastKind']) assert.throws(() => lib.validateFairPing({ ...fair, [key]: `${fair[key]}x` }), new RegExp(`fairPing\\.${key}`), key);
});

test('fair ping provenance is derived only from the exact three-row suffix after the click boundary', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const row = (text, kind, context = '', index = '') => ({ text, kind, context, index, pseudoLabel: 'none' });
  const decoy = [
    row('archon@stone-igloo:~$ ping 8.8.8.8', 'command'),
    row('64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=14.2 ms\n케이블이 빠져 있었습니다. 네트워크를 복구했습니다.', 'system'),
    row('아콘 🐧 // 지식은 레버리지가 아니다 애송아.', 'archon', 'puzzle', '1'),
  ];
  const suffix = structuredClone(decoy);
  const result = runner.deriveFairPingProvenance(decoy.length, [...decoy, ...suffix]);
  assert.equal(result.command, suffix[0].text);
  assert.equal(result.system, suffix[1].text);
  assert.equal(result.roast, suffix[2].text);
  assert.deepEqual(result.provenance, { beforeRowCount: 3, rows: suffix });
});

test('fair ping provenance rejects decoy-before with any after-suffix text, kind, order, or cardinality drift', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const row = (text, kind, context = '', index = '') => ({ text, kind, context, index, pseudoLabel: 'none' });
  const before = [row('archon@stone-igloo:~$ ping 8.8.8.8', 'command'), row('decoy', 'system'), row('decoy', 'archon', 'puzzle', '1')];
  const valid = [
    row('archon@stone-igloo:~$ ping 8.8.8.8', 'command'),
    row('64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=14.2 ms\n케이블이 빠져 있었습니다. 네트워크를 복구했습니다.', 'system'),
    row('아콘 🐧 // 지식은 레버리지가 아니다 애송아.', 'archon', 'puzzle', '1'),
  ];
  const hostile = [
    ['text drift', [{ ...valid[0], text: `${valid[0].text}x` }, valid[1], valid[2]]],
    ['kind drift', [valid[0], { ...valid[1], kind: 'command' }, valid[2]]],
    ['order drift', [valid[1], valid[0], valid[2]]],
    ['cardinality drift', valid.slice(0, 2)],
  ];
  for (const [label, suffix] of hostile) assert.throws(() => runner.deriveFairPingProvenance(before.length, [...before, ...suffix]), /fairPing\.provenance/, label);
});

test('current-product journey captures the row boundary immediately before fair click and derives only the after suffix', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8');
  const before = source.indexOf('const beforeFairDocument = await readDocumentSnapshot(page);');
  const boundary = source.indexOf('const beforeFairRowCount = beforeFairDocument.rows.length;', before);
  const click = source.indexOf("await click(page.getByRole('button', { name: '1. ping 8.8.8.8", boundary);
  const after = source.indexOf('const afterFairDocument = await readDocumentSnapshot(page);', click);
  const derive = source.indexOf('signature.fairPing = deriveFairPingProvenance(beforeFairRowCount, afterFairDocument.rows);', after);
  assert.ok(before >= 0 && before < boundary && boundary < click && click < after && after < derive);
  assert.equal(source.slice(before, click).match(/readDocumentSnapshot\(page\)/g)?.length, 1);
});

test('Task2 worker semantic gate requires fair ping provenance even when legacy Task1 signatures remain readable', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8');
  assert.match(source, /signature\?\.fairPing\?\.provenance/);
  assert.match(source, /fairPing\.provenance/);
});

test('Task2 worker semantic gate rejects fairPing deletion before full-case validation', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const observations = Array.from({ length: 6 }, () => ({ signature: {} }));
  assert.throws(() => runner.validateWorkerOwnedArtifacts({ observations, events: Array(278).fill({}) }), /worker\.semantic: fairPing\.provenance/);
});

test('Task2 worker publication rejects fairPing deletion without accepted manifest', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-fairping-worker-'));
  const configPath = path.join(root, 'operation.json'); const acceptedDir = path.join(root, 'accepted'); const failureRoot = path.join(root, 'failures'); const stageDir = path.join(root, `.public-smoke-v2.stage-${'9'.repeat(32)}`);
  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2, releaseId: '20260814T000000Z-r14-public-smoke-v2', acceptedDir, failureRoot }));
    await assert.rejects(runner.runWorkerFromArgv(['--config', configPath], {
      validateConfig: (value) => value,
      createStageDir: async () => { await mkdir(stageDir, { recursive: true }); return stageDir; },
      exchangePhase: async (phase) => ({ initialProbe: {}, finalProbe: {}, controlPlane: { phase: phase === 'initial' ? 'pre' : phase } }),
      runSmoke: async ({ onCaseFinished }) => { await onCaseFinished(3); return { observations: Array.from({ length: 6 }, () => ({ signature: {} })), events: Array(278).fill({}) }; },
    }), /worker\.semantic: fairPing\.provenance/);
    await assert.rejects(access(acceptedDir));
    const failures = await (await import('node:fs/promises')).readdir(failureRoot); assert.equal(failures.length, 1);
    await assert.rejects(access(path.join(failureRoot, failures[0], 'artifact-manifest.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Task2 operation accepted gate rejects fully rehashed fairPing deletion before audit or receipt publication', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs'); const lib = await import('../../scripts/public-smoke-v2-lib.mjs'); const { createHash } = await import('node:crypto');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-fairping-operation-')); const acceptedDir = path.join(root, 'accepted');
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  try {
    await mkdir(acceptedDir); const observationsPath = path.join(acceptedDir, 'observations.json');
    const observations = Array.from({ length: 6 }, () => ({ signature: { fairPing: validFairPingFixture() } }));
    delete observations[2].signature.fairPing;
    await writeFile(observationsPath, `${lib.canonicalJson(observations)}\n`);
    const observationBytes = await readFile(observationsPath); const manifestPayload = { schemaVersion: 1, releaseId: '20260814T000000Z-r14-public-smoke-v2', files: [{ path: 'observations.json', bytes: observationBytes.length, sha256: sha(observationBytes) }] };
    const manifest = { ...manifestPayload, manifestPayloadSha256: sha(lib.canonicalJson(manifestPayload)) }; const manifestPath = path.join(acceptedDir, 'artifact-manifest.json'); await writeFile(manifestPath, `${lib.canonicalJson(manifest)}\n`);
    const manifestSha256 = sha(await readFile(manifestPath)); const receipt = { accepted: { manifestSha256, treeDigest: sha(lib.canonicalJson({ files: manifest.files, manifestSha256 })) } };
    let audits = 0;
    await assert.rejects(operation.authenticateTask2Accepted({ acceptedDir, operationReceipt: receipt, auditAccepted: () => { audits += 1; } }), /task2\.fairPing\.provenance/);
    assert.equal(audits, 0); await assert.rejects(access(path.join(root, 'operation-receipt.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('single operation deadline supplies verifier and worker only the remaining budget', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  assert.equal(operation.remainingOperationBudget(100, 900_099.5), 0.5);
  assert.throws(() => operation.remainingOperationBudget(100, 900_100), /operation\.deadline/);
});

test('terminal operation budget includes revalidation, authentication, receipt wx, and the post-write check', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  const calls = [];
  const accepted = { eventCount: 278, screenshotBindings: Array(18).fill({}) };
  const exercise = async (ticks) => operation.orchestrateOperation({
    operationStartedMonotonicMs: 100,
    monotonicNow: () => ticks.shift(),
    runVerifier: async (remainingMs) => { calls.push(['verifier', remainingMs]); return { exitCode: 0, signal: null, stdout: 'R10_CAMPAIGN_GATE=VERIFIED\n', stderr: '' }; },
    runWorker: async (remainingMs) => { calls.push(['worker', remainingMs]); return { exitCode: 0, signal: null, stdout: '', stderr: '' }; },
    revalidateAccepted: async (remainingMs) => { calls.push(['revalidate', remainingMs]); return accepted; },
    authenticateAccepted: async (_value, remainingMs) => { calls.push(['authenticate', remainingMs]); },
    publishReceipt: async (_value, remainingMs) => { calls.push(['publish', remainingMs]); return { status: 'VERIFIED' }; },
  });
  assert.equal((await exercise([101, 102, 103, 104, 899_999.5, 899_999.999])).status, 'VERIFIED');
  assert.deepEqual(calls.map(([phase]) => phase), ['verifier', 'worker', 'revalidate', 'authenticate', 'publish']);
  calls.length = 0;
  await assert.rejects(exercise([101, 102, 103, 104, 899_999.5, 900_100]), /operation\.deadline/);
});

test('concrete operation threads one remaining budget into probes, Wrangler, revalidation, authentication, and checks both sides of receipt wx', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2-operation.mjs'), 'utf8');
  assert.match(source, /collectInitialProbe\(\{ config, stageDir, timeoutMs \}\)/);
  assert.match(source, /collectFinalProbe\(\{ config, stageDir, timeoutMs \}\)/);
  assert.match(source, /revalidateAccepted\(\{[\s\S]*?timeoutMs: remainingOperationBudget/);
  assert.match(source, /authenticateAccepted\(receipt, \{ timeoutMs: remainingOperationBudget/);
  assert.match(source, /publishOperationReceiptAtomically\(\{ receiptPath: config\.operationReceiptPath,[\s\S]*operationStartedMonotonicMs,[\s\S]*monotonicNow: deps\.monotonicNow \}\)/);
  const helper = source.slice(source.indexOf('export function publishOperationReceiptAtomically'), source.indexOf('export function validateExecutionSeal'));
  assert.equal((helper.match(/remainingOperationBudget\(/g) ?? []).length, 2);
});

test('probe fetch is actively aborted by its supplied remaining operation budget', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  let suppliedSignal;
  await assert.rejects(runner.fetchWithinBudget('https://fixture.invalid/', 5, async (_url, options) => {
    suppliedSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  }), /deadline/);
  assert.equal(suppliedSignal.aborted, true);
});

test('pre-public seal rejects tooling hash drift and hostile stage path before outer writes', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-seal-'));
  try {
    const node = path.join(root, 'node.exe'); const wrangler = path.join(root, 'wrangler.js');
    await writeFile(node, 'node'); await writeFile(wrangler, 'wrangler');
    const { createHash } = await import('node:crypto');
    const sha = (value) => createHash('sha256').update(value).digest('hex');
    const config = { releaseRoot: root, failureRoot: path.join(root, 'failures'), nodeExePath: node, nodeExeSha256: sha('node'), wranglerJsPath: wrangler, wranglerJsSha256: sha('wrangler') };
    const stage = path.join(root, '.public-smoke-v2.stage-' + 'a'.repeat(32)); await mkdir(stage);
    assert.doesNotThrow(() => operation.validateExecutionSeal(config, stage));
    assert.throws(() => operation.validateExecutionSeal({ ...config, nodeExeSha256: '0'.repeat(64) }, path.join(root, '.public-smoke-v2.stage-' + 'a'.repeat(32))), /seal/);
    assert.throws(() => operation.validateExecutionSeal(config, path.join(root, 'hostile-stage')), /seal/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worker-owned semantic validation rejects every invalid error channel and signature/ending before publication', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const valid = { observations: [{ errors: { console: [], page: [], requestFailed: [], http: [], external: [] }, signature: { command: 'ok' }, ending: { role: 'dialog' } }], events: [] };
  for (const [label, mutate] of [
    ['console', (v) => v.observations[0].errors.console.push({ type: 'error', text: 'boom' })],
    ['page', (v) => v.observations[0].errors.page.push({ name: 'Error', message: 'boom', stack: '' })],
    ['requestFailed', (v) => v.observations[0].errors.requestFailed.push({})],
    ['http', (v) => v.observations[0].errors.http.push({})],
    ['external', (v) => v.observations[0].errors.external.push({})],
    ['signature', (v) => { v.observations[0].signature.command = 'drift'; }],
    ['ending', (v) => { v.observations[0].ending.role = 'status'; }],
  ]) {
    const candidate = structuredClone(valid); mutate(candidate);
    assert.throws(() => runner.validateWorkerOwnedArtifacts(candidate), /worker\.semantic/, label);
  }
});

test('worker semantic rejection atomically publishes one diagnostic tree and no accepted manifest', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-semantic-fail-'));
  const configPath = path.join(root, 'operation.json');
  const releaseRoot = path.join(root, 'release');
  const acceptedDir = path.join(releaseRoot, 'accepted');
  const failureRoot = path.join(releaseRoot, 'failures');
  const stageDir = path.join(releaseRoot, `.public-smoke-v2.stage-${'a'.repeat(32)}`);
  try {
    await mkdir(releaseRoot);
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2, releaseId: '20260814T000000Z-r14-public-smoke-v2', acceptedDir, failureRoot }));
    await assert.rejects(runner.runWorkerFromArgv(['--config', configPath], {
      validateConfig: (value) => value,
      createStageDir: async () => { await mkdir(stageDir); return stageDir; },
      exchangePhase: async (phase) => ({ initialProbe: {}, finalProbe: {}, controlPlane: { phase: phase === 'initial' ? 'pre' : phase } }),
      runSmoke: async ({ onCaseFinished }) => { await onCaseFinished(3); return { observations: [{ errors: { console: [{ type: 'error', text: 'boom' }], page: [], requestFailed: [], http: [], external: [] } }], events: Array(278).fill({}) }; },
    }), /worker\.semantic/);
    await assert.rejects(access(acceptedDir));
    const failures = await (await import('node:fs/promises')).readdir(failureRoot);
    assert.equal(failures.length, 1);
    const diagnostic = path.join(failureRoot, failures[0]);
    assert.match(failures[0], /^public-smoke-v2-failure-/);
    await assert.rejects(access(path.join(diagnostic, 'artifact-manifest.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('newContext creation is actively bounded and closes a hung browser', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  let closed = 0;
  const browser = { newContext: () => new Promise(() => {}), close: async () => { closed += 1; } };
  await assert.rejects(runner.createContextWithinDeadline(browser, { viewport: { width: 320, height: 640 } }, 10), /case\.deadline/);
  assert.equal(closed, 1);
});

test('every case context blocks service workers while preserving the fixed viewport', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const calls = [];
  const context = { close: async () => {} };
  const browser = { newContext: async (options) => { calls.push(options); return context; }, close: async () => {} };
  assert.equal(await runner.createContextWithinDeadline(browser, { viewport: { width: 320, height: 640 } }, 120000), context);
  assert.deepEqual(calls, [{ viewport: { width: 320, height: 640 }, serviceWorkers: 'block' }]);
});

test('preflight rejects absent-contract roots and derived verifier streams before any spawn', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-derived-output-'));
  try {
    const config = { releaseRoot: root, failureRoot: path.join(root, 'failures') };
    for (const [label, target] of [
      ['failureRoot', config.failureRoot],
      ['campaignVerifierStdout', path.join(root, 'campaign-verifier.stdout.bin')],
      ['campaignVerifierStderr', path.join(root, 'campaign-verifier.stderr.bin')],
    ]) {
      await mkdir(path.dirname(target), { recursive: true });
      if (label === 'failureRoot') await mkdir(target); else await writeFile(target, '');
      assert.throws(() => operation.assertOperationOutputsAbsent(config), new RegExp(`operation\\.preflight\\.${label}`));
      await rm(target, { recursive: true, force: true });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('outer phase seal runs before every probe or control-plane writer', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2-operation.mjs'), 'utf8');
  assert.match(source, /phaseAuthority[\s\S]*validateExecutionSeal\(config, stageDir\)[\s\S]*collectInitialProbe/);
});

test('pinned parser authority rejects missing and byte-drifted executables', async () => {
  const lib = await import('../../scripts/public-smoke-v2-lib.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-parser-authority-'));
  try {
    const missing = path.join(root, 'missing.exe');
    assert.throws(() => lib.validatePinnedParserAuthority({ parserPath: missing, expectedSha256: '0'.repeat(64), expectedVersion: 'ast-grep 0.44.0' }), /runner\.parserAuthority/);
    const drift = path.join(root, 'ast-grep.exe');
    await writeFile(drift, 'not the pinned parser');
    assert.throws(() => lib.validatePinnedParserAuthority({ parserPath: drift, expectedSha256: '0'.repeat(64), expectedVersion: 'ast-grep 0.44.0' }), /runner\.parserAuthority/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runner policy ignores a hostile PATH ast-grep and uses the pinned parser authority', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8');
  const previous = process.env.PATH;
  process.env.PATH = '';
  try { assert.doesNotThrow(() => validateRunnerSourcePolicy(source)); }
  finally { process.env.PATH = previous; }
});

for (const [label, source] of [
  ['Function.call mutation', 'export async function readDocumentSnapshot(page) { return page.evaluate(() => node.setAttribute.call(node, "hidden", "")); }'],
  ['Function.apply mutation', 'export async function readDocumentSnapshot(page) { return page.evaluate(() => node.removeAttribute.apply(node, ["hidden"])); }'],
  ['Reflect.construct execution', 'export async function readDocumentSnapshot(page) { return page.evaluate(() => Reflect.construct(Function, ["document.body.remove()"])); }'],
  ['indirect eval execution', 'export async function readDocumentSnapshot(page) { return page.evaluate(() => (0, eval)("document.body.remove()")); }'],
  ['location navigation', 'export async function readDocumentSnapshot(page) { return page.evaluate(() => location.assign("https://example.invalid")); }'],
  ['document stream write', 'export async function readDocumentSnapshot(page) { return page.evaluate(() => document.write("forged")); }'],
]) test(`true callback AST allowlist rejects ${label}`, () => assert.throws(() => validateRunnerSourcePolicy(source), /runner\.policy/));

test('runner policy implementation is a pinned AST allowlist rather than a regex deny-list', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'public-smoke-v2-lib.mjs'), 'utf8');
  assert.doesNotMatch(source, /const forbidden\s*=|spawnSync\(['"]ast-grep['"]/);
  assert.match(source, /PINNED_AST_GREP_PATH/);
  assert.match(source, /validatePinnedParserAuthority/);
});

test('operation parser preflight fails missing or drifted pinned authority before verifier, public, worker, or outputs', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  const lib = await import('../../scripts/public-smoke-v2-lib.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-operation-parser-seal-'));
  const releaseRoot = path.join(root, 'release'); const campaignDir = path.join(root, 'campaign'); const sourceSnapshotDir = path.join(campaignDir, 'source');
  const configPath = path.join(root, 'operation.json'); const drift = path.join(root, 'ast-grep.exe');
  try {
    await mkdir(path.join(sourceSnapshotDir, 'scripts'), { recursive: true }); await mkdir(releaseRoot);
    await writeFile(path.join(sourceSnapshotDir, 'scripts', 'run-public-smoke-v2.mjs'), 'export const fixture = true;\n');
    await writeFile(drift, 'drift');
    const output = (name) => path.join(releaseRoot, name);
    const config = {
      schemaVersion: 2, releaseId: '20260814T000000Z-r14-public-smoke-v2', releaseRoot,
      acceptedDir: output('accepted'), failureRoot: output('failures'), operationReceiptPath: output('operation.json'), auditReceiptPath: output('audit.json'), negativeReceiptPath: output('negative.json'), closureRoot: output('closure'), closureReceiptPath: output('closure.json'), actualChromeEvidencePath: output('chrome.json'), releaseReceiptPath: output('release.json'), workerStdoutPath: output('worker.out'), workerStderrPath: output('worker.err'),
      campaignDir, campaignSpecPath: path.join(root, 'spec.json'), campaignReceiptPath: path.join(root, 'campaign.json'), campaignRunId: '20260813T000000Z-r10-korean-release', sourceSnapshotDir, executionSourceDir: path.join(root, 'execution'), authorityProjectRoot: root, authorityWorkspaceRoot: path.dirname(root), deploymentRecordPath: output('deployment.json'), deploymentOperatorReceiptPath: output('operator-deployment-receipt.json'), immutableUrl: 'https://01234567.penguin-exit-0.pages.dev/', aliasUrl: 'https://penguin-exit-0.pages.dev/', nodeExePath: await (await import('node:fs/promises')).realpath(process.execPath), nodeExeSha256: '1'.repeat(64), wranglerJsPath: path.join(root, 'wrangler.js'), wranglerJsSha256: '2'.repeat(64), projectName: 'penguin-exit-0', accountId: '0123456789abcdef0123456789abcdef', sourceGitTree: 'b'.repeat(40),
    };
    await writeFile(configPath, JSON.stringify(config));
    for (const [label, parserPath] of [['missing', path.join(root, 'missing.exe')], ['drift', drift]]) {
      let policyCalls = 0; let spawnCalls = 0; let publicCalls = 0;
      await assert.rejects(operation.runOperationFromArgv(['--config', configPath], {
        validateRunnerPolicy: () => { policyCalls += 1; return lib.validatePinnedParserAuthority({ parserPath, expectedSha256: '0'.repeat(64), expectedVersion: 'ast-grep 0.44.0' }); },
        validatePreflightSeal: () => true,
        spawnProcess: async () => { spawnCalls += 1; },
        phaseAuthority: async () => { publicCalls += 1; },
      }), /runner\.parserAuthority/, label);
      assert.equal(policyCalls, 1, label); assert.equal(spawnCalls, 0, label); assert.equal(publicCalls, 0, label);
      await assert.rejects(access(config.acceptedDir), undefined, label); await assert.rejects(access(config.operationReceiptPath), undefined, label);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Playwright authority follows actual Node resolution outside the worktree and binds accepted tooling bytes', async () => {
  const lib = await import('../../scripts/public-smoke-v2-lib.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-playwright-authority-'));
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { '@playwright/test': '1.62.1' } }));
    const playwrightDir = path.join(root, 'node_modules', 'playwright');
    await mkdir(playwrightDir, { recursive: true });
    await writeFile(path.join(playwrightDir, 'package.json'), JSON.stringify({ name: 'playwright', version: '1.62.1' }));
    const requireFromRoot = createRequire(path.join(root, 'package.json'));
    const authority = lib.resolvePlaywrightAuthority(root, { resolvePackage: requireFromRoot.resolve });
    assert.equal(authority.path, 'node_modules/playwright/package.json');
    assert.equal(authority.version, '1.62.1');
    assert.match(authority.sha256, /^[a-f0-9]{64}$/);
    assert.match(authority.resolvedPath, /node_modules[\\/]playwright[\\/]package\.json$/);
    assert.equal(authority.resolvedPath.startsWith(projectRoot), false);
    assert.equal(authority.resolvedPath.startsWith(root), true);
    assert.doesNotThrow(() => lib.validatePlaywrightToolingDeclaration(authority, { path: authority.path, version: authority.version, sha256: authority.sha256 }));
    assert.throws(() => lib.validatePlaywrightToolingDeclaration(authority, { path: authority.path, version: authority.version, sha256: '0'.repeat(64) }), /playwrightAuthority/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Playwright authority rejects source declaration version drift and noncanonical resolved package files', async () => {
  const lib = await import('../../scripts/public-smoke-v2-lib.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-playwright-drift-'));
  const fake = path.join(root, 'package.json');
  try {
    await writeFile(fake, JSON.stringify({ name: '@playwright/test', version: '1.62.1' }));
    const source = path.join(root, 'source'); await mkdir(source); await writeFile(path.join(source, 'package.json'), JSON.stringify({ devDependencies: { '@playwright/test': '1.62.0' } }));
    assert.throws(() => lib.resolvePlaywrightAuthority(source, { resolvePackage: () => fake }), /playwrightAuthority\.version/);
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ devDependencies: { '@playwright/test': '1.62.1' } }));
    assert.throws(() => lib.resolvePlaywrightAuthority(source, { resolvePackage: () => `${root}\\missing\\..\\package.json` }), /playwrightAuthority/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production preflight and accepted-run producer both use the same resolved Playwright authority', async () => {
  const operationSource = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2-operation.mjs'), 'utf8');
  const runnerSource = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8');
  assert.match(operationSource, /resolvePlaywrightAuthority\(config\.sourceSnapshotDir\)/);
  assert.match(runnerSource, /resolvePlaywrightAuthority\(config\.sourceSnapshotDir\)/);
});

for (const [label, injected] of [
  ['forced direct click', "\nasync function attack(page){ await page.locator('#btn-produce').click({ force: true }); }\n"],
  ['test hook', "\nfunction attack(page){ page.on('testhook', () => {}); }\n"],
  ['addCookies', "\nasync function attack(context){ await context.addCookies([{name:'x',value:'1',url:'https://example.invalid'}]); }\n"],
  ['computed evaluate', "\nasync function attack(page){ return page['evaluate'](() => document.title); }\n"],
]) test(`whole-source AST policy rejects production-shaped ${label}`, async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8');
  assert.doesNotThrow(() => validateRunnerSourcePolicy(source));
  assert.throws(() => validateRunnerSourcePolicy(`${source}${injected}`), /runner\.policy/);
});

test('whole-source AST callback allowlist rejects application property reads inside an otherwise named probe', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8');
  const attacked = source.replace('title: document.title,', 'title: document.title, forged: application.state,');
  assert.notEqual(attacked, source);
  assert.throws(() => validateRunnerSourcePolicy(attacked), /runner\.policy/);
});

test('receipt publication uses a fsynced sibling temp, no-replace atomic final, and removes final on post-write deadline equality', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-receipt-atomic-'));
  const receiptPath = path.join(root, 'operation-receipt.json');
  try {
    const run = async (ticks) => operation.publishOperationReceiptAtomically({ receiptPath, bytes: Buffer.from('{"status":"VERIFIED"}\n'), operationStartedMonotonicMs: 100, monotonicNow: () => ticks.shift() });
    await assert.rejects(run([900_099.5, 900_100]), /operation\.deadline/);
    await assert.rejects(access(receiptPath));
    assert.deepEqual((await (await import('node:fs/promises')).readdir(root)).filter((name) => name.includes('.tmp-')), []);
    assert.equal(await run([900_099.5, 900_099.999]), receiptPath);
    assert.equal(await readFile(receiptPath, 'utf8'), '{"status":"VERIFIED"}\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('receipt atomic publication never replaces a pre-existing final file', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-receipt-no-replace-')); const receiptPath = path.join(root, 'receipt.json');
  try {
    await writeFile(receiptPath, 'prior\n');
    assert.throws(() => operation.publishOperationReceiptAtomically({ receiptPath, bytes: Buffer.from('new\n'), operationStartedMonotonicMs: 0, monotonicNow: () => 1 }), /EEXIST|receiptAbsent/);
    assert.equal(await readFile(receiptPath, 'utf8'), 'prior\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production operation publishes its final receipt only through terminal-budget atomic publication', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2-operation.mjs'), 'utf8');
  assert.match(source, /publishReceipt: \(receipt\) => publishOperationReceiptAtomically\(\{ receiptPath: config\.operationReceiptPath/);
  assert.doesNotMatch(source, /writeFileSync\(config\.operationReceiptPath/);
});

test('probe deadline remains active through a hanging response body and aborts it', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  let aborted = false;
  await assert.rejects(runner.fetchProbeBytesWithinDeadline('https://fixture.invalid/', {
    deadlineMonotonicMs: performance.now() + 20,
    monotonicNow: () => performance.now(),
    fetchImpl: async (_url, { signal }) => ({ arrayBuffer: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true })) }),
  }), /deadline/);
  assert.equal(aborted, true);
});

test('probe requests recompute one global phase remainder before every request', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const delays = []; const clock = [10, 25];
  const options = {
    deadlineMonotonicMs: 100,
    monotonicNow: () => clock.shift(),
    fetchImpl: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }),
    setTimeoutImpl: (_callback, delay) => { delays.push(delay); return delays.length; }, clearTimeoutImpl: () => {},
  };
  await runner.fetchProbeBytesWithinDeadline('https://fixture.invalid/1', options);
  await runner.fetchProbeBytesWithinDeadline('https://fixture.invalid/2', options);
  assert.deepEqual(delays, [90, 75]);
});

test('initial probe phase timeout during body consumption creates no completed parent probe artifact', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-probe-body-timeout-'));
  try {
    await assert.rejects(runner.collectInitialProbe({
      config: { immutableUrl: 'https://fixture.invalid/', aliasUrl: 'https://alias.invalid/' }, stageDir: root, timeoutMs: 20,
      authority: { deployment: { deploymentId: 'dep', immutableUrl: 'https://fixture.invalid/' }, sourceGitHead: 'a'.repeat(40), productFiles: {} },
      fetchImpl: async (_url, { signal }) => ({ arrayBuffer: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }),
    }), /deadline/);
    await assert.rejects(access(path.join(root, 'file-probes', 'initial-10.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [label, childSource] of [
  ['nonzero after INITIAL', (stage) => `process.send({type:'READY_INITIAL',stageDir:${JSON.stringify(stage)}}); process.once('message',()=>process.exit(7));`],
  ['signal after MID', (stage) => `let n=0; process.send({type:'READY_INITIAL',stageDir:${JSON.stringify(stage)}}); process.on('message',()=>{ if(n++===0) process.send({type:'READY_MID',stageDir:${JSON.stringify(stage)}}); else process.kill(process.pid,'SIGTERM'); });`],
]) test(`outer moves one trusted stage on abrupt worker ${label}`, async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-abrupt-worker-')); const releaseRoot = path.join(root, 'release'); const failureRoot = path.join(releaseRoot, 'failures');
  const stage = path.join(releaseRoot, `.public-smoke-v2.stage-${'d'.repeat(32)}`); const child = path.join(root, 'child.mjs');
  try {
    await mkdir(stage, { recursive: true }); await writeFile(path.join(stage, 'owned.txt'), label); await writeFile(child, childSource(stage));
    const result = await operation.spawnCapturedProcess({ argv: [process.execPath, child], cwd: root, stdoutPath: path.join(root, 'out'), stderrPath: path.join(root, 'err'), timeoutMs: 2000, releaseRoot, failureRoot, phaseAuthority: async () => ({}) });
    assert.equal(result.exitCode !== 0 || result.signal !== null, true);
    await assert.rejects(access(stage));
    const failures = await (await import('node:fs/promises')).readdir(failureRoot); assert.equal(failures.length, 1);
    assert.equal(await readFile(path.join(failureRoot, failures[0], 'owned.txt'), 'utf8'), label);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production operation executes the real preflight seal without a validatePreflightSeal override', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-real-preflight-')); const releaseRoot = path.join(root, 'release'); const campaignDir = path.join(root, 'campaign'); const sourceSnapshotDir = path.join(campaignDir, 'source');
  const configPath = path.join(root, 'operation.json');
  try {
    await mkdir(path.join(sourceSnapshotDir, 'scripts'), { recursive: true }); await mkdir(releaseRoot); await mkdir(path.join(root, 'execution'));
    for (const relative of ['scripts/run-public-smoke-v2-operation.mjs', 'scripts/run-public-smoke-v2.mjs', 'scripts/public-smoke-v2-lib.mjs', 'package.json']) {
      const target = path.join(sourceSnapshotDir, ...relative.split('/')); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, await readFile(path.join(projectRoot, ...relative.split('/'))));
    }
    await writeFile(path.join(sourceSnapshotDir, 'scripts', 'verify-r10-campaign.mjs'), '// fixture\n');
    const nodeExePath = await (await import('node:fs/promises')).realpath(process.execPath); const wranglerJsPath = path.join(root, 'wrangler.js'); await writeFile(wranglerJsPath, 'fixture');
    const sha = async (file) => (await import('node:crypto')).createHash('sha256').update(await readFile(file)).digest('hex'); const output = (name) => path.join(releaseRoot, name);
    const config = { schemaVersion: 2, releaseId: '20260814T000000Z-r14-public-smoke-v2', releaseRoot, acceptedDir: output('accepted'), failureRoot: output('failures'), operationReceiptPath: output('operation-receipt.json'), auditReceiptPath: output('audit.json'), negativeReceiptPath: output('negative.json'), closureRoot: output('closure'), closureReceiptPath: output('closure.json'), actualChromeEvidencePath: output('chrome.json'), releaseReceiptPath: output('release.json'), workerStdoutPath: output('worker.out'), workerStderrPath: output('worker.err'), campaignDir, campaignSpecPath: path.join(root, 'spec.json'), campaignReceiptPath: path.join(root, 'campaign-receipt.json'), campaignRunId: '20260813T000000Z-r10-korean-release', sourceSnapshotDir, executionSourceDir: path.join(root, 'execution'), authorityProjectRoot: root, authorityWorkspaceRoot: path.dirname(root), deploymentRecordPath: output('deployment.json'), deploymentOperatorReceiptPath: output('operator-deployment-receipt.json'), immutableUrl: 'https://01234567.penguin-exit-0.pages.dev/', aliasUrl: 'https://penguin-exit-0.pages.dev/', nodeExePath, nodeExeSha256: await sha(nodeExePath), wranglerJsPath, wranglerJsSha256: await sha(wranglerJsPath), projectName: 'penguin-exit-0', accountId: '0123456789abcdef0123456789abcdef', sourceGitTree: 'b'.repeat(40) };
    await writeFile(configPath, JSON.stringify(config)); let spawns = 0;
    await assert.rejects(operation.runOperationFromArgv(['--config', configPath], { spawnProcess: async ({ stdoutPath, stderrPath }) => { spawns += 1; await writeFile(stdoutPath, 'NOT_VERIFIED\n', { flag: 'wx' }); await writeFile(stderrPath, '', { flag: 'wx' }); return { exitCode: 0, signal: null }; } }), /operation\.campaignVerifier/);
    assert.equal(spawns, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [label, injected] of [
  ['page arbitrary evaluate split', "async function attack(page){ return page['e'+'valuate'](() => document.title); }"],
  ['context arbitrary addCookies split', "async function attack(context){ return context['add'+'Cookies']([]); }"],
  ['browser arbitrary route split', "async function attack(browser){ return browser['rou'+'te']('**/*',()=>{}); }"],
  ['aliased page computed call', "async function attack(page){ const p = page; return p['ev'+'aluate'](() => document.title); }"],
  ['aliased locator computed call', "async function attack(page){ const l = page.locator('#btn'); return l['cl'+'ick'](); }"],
  ['optional computed call', "async function attack(page){ const p = page; return p?.['ev'+'aluate'](() => document.title); }"],
]) test(`computed capability architecture rejects ${label}`, async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8');
  assert.throws(() => validateRunnerSourcePolicy(`${source}\n${injected}\n`), /runner\.policy\.computedCapability/);
});

for (const split of [1, 2, 3, 4, 5, 6, 7]) test(`computed capability randomized evaluate split ${split}`, async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8');
  const word = 'evaluate'; const expression = `'${word.slice(0, split)}'+'${word.slice(split)}'`;
  assert.throws(() => validateRunnerSourcePolicy(`${source}\nasync function attack(page){ const alias = page; return alias[${expression}](() => document.title); }\n`), /runner\.policy\.computedCapability/);
});

for (const [label, later] of [
  ['unknown key', { Id: 'old', Environment: 'Production', Branch: 'main', Source: 'bbbbbbb', Deployment: 'https://old.pages.dev/', Status: 'success', Build: 'ok', Extra: 'x' }],
  ['missing key', { Id: 'old', Environment: 'Production', Branch: 'main', Source: 'bbbbbbb', Deployment: 'https://old.pages.dev/', Status: 'success' }],
  ['type drift', { Id: 7, Environment: 'Production', Branch: 'main', Source: 'bbbbbbb', Deployment: 'https://old.pages.dev/', Status: 'success', Build: 'ok' }],
]) test(`Wrangler row validator rejects malformed later row ${label}`, async () => {
  const lib = await import('../../scripts/public-smoke-v2-lib.mjs');
  const first = { Id: 'dep', Environment: 'Production', Branch: 'main', Source: 'aaaaaaa', Deployment: 'https://immutable.pages.dev/', Status: 'success', Build: 'ok' };
  assert.throws(() => lib.validateWranglerRows([first, later], { deploymentId: 'dep', immutableUrl: first.Deployment, sourceGitHead: 'a'.repeat(40) }), /authority\.wranglerRows/);
});

test('control-plane collector rejects malformed later Wrangler row before returning an ACK payload', async () => {
  const runner = await import('../../scripts/run-public-smoke-v2.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-wrangler-later-row-'));
  const first = { Id: 'dep', Environment: 'Production', Branch: 'main', Source: 'aaaaaaa', Deployment: 'https://immutable.pages.dev/', Status: 'success', Build: 'ok' };
  try {
    await assert.rejects(runner.collectControlPlane('pre', {
      config: { nodeExePath: process.execPath, wranglerJsPath: path.join(root, 'wrangler.js'), projectName: 'p', authorityProjectRoot: root, nodeExeSha256: '1'.repeat(64), wranglerJsSha256: '2'.repeat(64) }, stageDir: root,
      authority: { deployment: { deploymentId: 'dep', immutableUrl: first.Deployment }, sourceGitHead: 'a'.repeat(40), productFiles: { '/': { mime: 'text/html', bytes: 1, sha256: 'b'.repeat(64) } } },
      spawnImpl: () => ({ status: 0, signal: null, stdout: Buffer.from(JSON.stringify([first, { ...first, Extra: 'x' }])), stderr: Buffer.alloc(0) }),
    }), /authority\.wranglerRows/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Playwright authority binds the actual playwright package imported by the runner', async () => {
  const lib = await import('../../scripts/public-smoke-v2-lib.mjs'); const { createRequire } = await import('node:module'); const { pathToFileURL } = await import('node:url');
  const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-actual-playwright-'));
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { '@playwright/test': '1.62.1' } }));
    const expectedPath = createRequire(pathToFileURL(path.join(projectRoot, 'scripts', 'run-public-smoke-v2.mjs'))).resolve('playwright/package.json');
    const authority = lib.resolvePlaywrightAuthority(root);
    assert.equal(authority.resolvedPath, expectedPath);
    assert.equal(authority.path, 'node_modules/playwright/package.json');
    assert.equal(JSON.parse(await readFile(authority.resolvedPath, 'utf8')).name, 'playwright');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('accepted tooling rejects playwright-only byte drift with runner and library unchanged', async () => {
  const lib = await import('../../scripts/public-smoke-v2-lib.mjs'); const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-playwright-only-drift-'));
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { '@playwright/test': '1.62.1' } }));
    const authority = lib.resolvePlaywrightAuthority(root);
    assert.throws(() => lib.validatePlaywrightToolingDeclaration(authority, { path: authority.path, version: authority.version, sha256: authority.sha256.replace(/^./, authority.sha256[0] === '0' ? '1' : '0') }), /playwrightAuthority/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [label, terminate] of [
  ['exit2', 'process.exit(2)'],
  ['signal', "process.kill(process.pid,'SIGTERM')"],
]) test(`outer recovers same-inode accepted publication after post-rename worker ${label}`, async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs'); const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-post-rename-'));
  const releaseRoot = path.join(root, 'release'); const failureRoot = path.join(releaseRoot, 'failures'); const acceptedDir = path.join(releaseRoot, 'accepted'); const releaseId = '20260814T000000Z-r14-public-smoke-v2';
  const stage = path.join(releaseRoot, `.public-smoke-v2.stage-${'e'.repeat(32)}`); const child = path.join(root, 'child.mjs');
  try {
    await mkdir(stage, { recursive: true });
    const script = `import fs from 'node:fs'; process.send({type:'READY_INITIAL',stageDir:${JSON.stringify(stage)}}); process.once('message',()=>{ fs.writeFileSync(${JSON.stringify(path.join(stage, 'accepted-run.json'))},JSON.stringify({releaseId:${JSON.stringify(releaseId)}})); fs.writeFileSync(${JSON.stringify(path.join(stage, 'artifact-manifest.json'))},JSON.stringify({releaseId:${JSON.stringify(releaseId)}})); fs.writeFileSync(${JSON.stringify(path.join(stage, 'diagnostic.txt'))},'preserve'); fs.renameSync(${JSON.stringify(stage)},${JSON.stringify(acceptedDir)}); ${terminate}; });`;
    await writeFile(child, script);
    const result = await operation.spawnCapturedProcess({ argv: [process.execPath, child], cwd: root, stdoutPath: path.join(root, 'out'), stderrPath: path.join(root, 'err'), timeoutMs: 2000, releaseRoot, failureRoot, acceptedDir, releaseId, phaseAuthority: async () => ({}) });
    assert.equal(result.exitCode !== 0 || result.signal !== null, true);
    await assert.rejects(access(acceptedDir));
    const failures = await (await import('node:fs/promises')).readdir(failureRoot); assert.equal(failures.length, 1);
    await assert.rejects(access(path.join(failureRoot, failures[0], 'artifact-manifest.json')));
    assert.equal(await readFile(path.join(failureRoot, failures[0], 'diagnostic.txt'), 'utf8'), 'preserve');
    await assert.rejects(access(path.join(releaseRoot, 'operation-receipt.json')));
    assert.deepEqual((await (await import('node:fs/promises')).readdir(releaseRoot)).filter((name) => name.includes('.tmp-')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('outer leaves a preexisting different-inode accepted tree untouched after trusted stage disappears', async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs'); const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-untrusted-accepted-'));
  const releaseRoot = path.join(root, 'release'); const failureRoot = path.join(releaseRoot, 'failures'); const acceptedDir = path.join(releaseRoot, 'accepted'); const releaseId = '20260814T000000Z-r14-public-smoke-v2';
  const stage = path.join(releaseRoot, `.public-smoke-v2.stage-${'f'.repeat(32)}`); const child = path.join(root, 'child.mjs');
  try {
    await mkdir(stage, { recursive: true }); await mkdir(acceptedDir); await writeFile(path.join(acceptedDir, 'sentinel.txt'), 'preexisting');
    await writeFile(child, `import fs from 'node:fs'; process.send({type:'READY_INITIAL',stageDir:${JSON.stringify(stage)}}); process.once('message',()=>{fs.rmSync(${JSON.stringify(stage)},{recursive:true});process.exit(2);});`);
    await operation.spawnCapturedProcess({ argv: [process.execPath, child], cwd: root, stdoutPath: path.join(root, 'out'), stderrPath: path.join(root, 'err'), timeoutMs: 2000, releaseRoot, failureRoot, acceptedDir, releaseId, phaseAuthority: async () => ({}) });
    assert.equal(await readFile(path.join(acceptedDir, 'sentinel.txt'), 'utf8'), 'preexisting'); await assert.rejects(access(failureRoot));
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [label, injected] of [
  ['object property hop', "async function attack(page){ const box={cap:page}; return box.cap?.['ev'+'aluate'](()=>document.title); }"],
  ['factory return hop', "async function attack(page){ const factory=()=>page; return factory()?.['ev'+'aluate'](()=>document.title); }"],
  ['randomized dynamic key', "async function attack(page){ const key=['ev','alu','ate'].join(''); return ({value:page}).value?.[key](()=>document.title); }"],
]) test(`computed-call architecture rejects ${label}`, async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8');
  assert.doesNotThrow(() => validateRunnerSourcePolicy(source));
  assert.throws(() => validateRunnerSourcePolicy(`${source}\n${injected}\n`), /runner\.policy\.computedCall/);
});

for (const failurePoint of ['revalidate', 'validateReceipt', 'authenticate', 'publish']) test(`post-worker success ${failurePoint} failure removes accepted and publishes one diagnostic tree`, async () => {
  const operation = await import('../../scripts/run-public-smoke-v2-operation.mjs'); const root = await mkdtemp(path.join(tmpdir(), 'r14-task2-post-worker-gate-'));
  const acceptedDir = path.join(root, 'accepted'); const failureRoot = path.join(root, 'failures'); const receiptPath = path.join(root, 'operation-receipt.json'); const releaseId = '20260814T000000Z-r14-public-smoke-v2';
  try {
    await mkdir(acceptedDir); await writeFile(path.join(acceptedDir, 'accepted-run.json'), JSON.stringify({ releaseId })); await writeFile(path.join(acceptedDir, 'artifact-manifest.json'), JSON.stringify({ releaseId })); await writeFile(path.join(acceptedDir, 'diagnostic.txt'), 'preserve');
    const stat = await (await import('node:fs/promises')).lstat(acceptedDir); const pinnedIdentity = { dev: stat.dev, ino: stat.ino };
    const fail = (name) => { if (failurePoint === name) throw new Error(`fixture.${name}`); };
    await assert.rejects(operation.runPostWorkerGates({
      revalidateAccepted: async () => { fail('revalidate'); return { eventCount: 278 }; },
      createReceipt: () => ({ status: 'VERIFIED' }), validateReceipt: () => fail('validateReceipt'), authenticateAccepted: async () => fail('authenticate'),
      publishReceipt: async () => { fail('publish'); await writeFile(receiptPath, 'unexpected'); },
      recoverAccepted: () => operation.recoverAcceptedPublication({ acceptedDir, failureRoot, releaseId, pinnedIdentity }),
    }), new RegExp(`fixture\\.${failurePoint}`));
    await assert.rejects(access(acceptedDir)); await assert.rejects(access(receiptPath));
    const failures = await (await import('node:fs/promises')).readdir(failureRoot); assert.equal(failures.length, 1);
    await assert.rejects(access(path.join(failureRoot, failures[0], 'artifact-manifest.json')));
    assert.equal(await readFile(path.join(failureRoot, failures[0], 'diagnostic.txt'), 'utf8'), 'preserve');
    assert.deepEqual((await (await import('node:fs/promises')).readdir(root)).filter((name) => name.includes('.tmp-')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production operation wraps every post-worker gate in recovery and receives pinned worker identity', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2-operation.mjs'), 'utf8');
  assert.match(source, /await runPostWorkerGates\(\{/);
  assert.match(source, /pinnedIdentity: worker\.pinnedIdentity/);
  assert.match(source, /revalidateAccepted:[\s\S]*validateReceipt:[\s\S]*authenticateAccepted:[\s\S]*publishReceipt:/);
});

const forbiddenCapabilityMethods = [
  ['evaluate', 'page', '() => document.title'],
  ['click-force', "page.locator('#target')", '{ force: true }', 'click'],
  ['setContent', 'page', "'<main>forged</main>'"],
  ['addCookies', 'context', '[]'],
  ['route', 'page', "'**/*', () => {}"],
  ['addInitScript', 'context', '() => {}'],
  ['dispatchEvent', 'page', "'#target', 'click'"],
  ['exposeFunction', 'page', "'forged', () => true"],
];

const forbiddenCapabilityShapes = [
  ['direct', (receiver, method, args) => `return ${receiver}.${method}(${args});`],
  ['alias', (receiver, method, args) => `const capability = ${receiver}; return capability.${method}(${args});`],
  ['destructure', (receiver, method, args) => `const { ${method}: invoke } = ${receiver}; return invoke(${args});`],
  ['computed', (receiver, method, args) => `const capability = ${receiver}; return capability['${method}'](${args});`],
  ['optional', (receiver, method, args) => `const capability = ${receiver}; return capability?.${method}(${args});`],
];

for (const [apiLabel, receiver, args, method = apiLabel] of forbiddenCapabilityMethods) {
  for (const [shapeLabel, buildBody] of forbiddenCapabilityShapes) {
    test(`capability policy rejects ${apiLabel} through ${shapeLabel}`, async () => {
      const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8');
      const attack = `async function attack(page, context, browser, browserType, locator) { ${buildBody(receiver, method, args)} }`;
      assert.throws(() => validateRunnerSourcePolicy(`${source}\n${attack}\n`), /runner\.policy/);
    });
  }
}

for (const [label, attack] of [
  ['destructured shorthand', "async function attack(page) { const { setContent } = page; return setContent('<main>forged</main>'); }"],
  ['renamed destructured locator method', "async function attack(page) { const { click: invoke } = page.locator('#target'); return invoke({ force: true }); }"],
  ['renamed destructured factory capability', "async function attack(page) { const factory = () => page; const { setContent: invoke } = factory(); return invoke('<main>forged</main>'); }"],
  ['rest destructured capability', "async function attack(context) { const { close, ...rest } = context; return rest.addCookies([]); }"],
]) test(`capability policy fails closed for ${label}`, async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'run-public-smoke-v2.mjs'), 'utf8');
  assert.throws(() => validateRunnerSourcePolicy(`${source}\n${attack}\n`), /runner\.policy/);
});
