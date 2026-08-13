import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import test from 'node:test';
import {
    AVAILABILITY_TIMEOUT_MS,
    isStaticServerAvailable,
    SERVER_URL,
    startStaticServer,
    stopStaticServer,
} from '../browser/serve.mjs';

const execFileAsync = promisify(execFile);
const cliPath = './node_modules/@playwright/test/cli.js';
const accessibilityArgs = [
    cliPath, 'test', 'tests/browser/accessibility.spec.js', '--project=chromium', '--workers=1',
    '--grep', '탭은 클릭과 키보드 조작에서 선택 상태와 패널 연결을 동기화한다$',
];

function get(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => resolve({ statusCode: response.statusCode, body }));
        }).on('error', reject);
    });
}

function isServerReachable() {
    return get(`${SERVER_URL}/`).then(() => true, () => false);
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(4173, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
}

function close(server) {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

async function runAccessibilityCli() {
    const startedAt = performance.now();
    const result = await execFileAsync(process.execPath, accessibilityArgs, {
        cwd: process.cwd(),
        timeout: 15000,
    });

    return { elapsedMs: performance.now() - startedAt, ...result };
}

test('static server starts on a requested port and closes its listener', async () => {
    const server = await startStaticServer({ port: 0 });
    const { port } = server.address();

    try {
        const response = await get(`http://127.0.0.1:${port}/`);
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /id="btn-produce"/);
    } finally {
        await stopStaticServer(server);
    }

    assert.equal(server.listening, false);
});

test('availability accepts a localized document with the stable produce-button marker', async () => {
    const server = http.createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<button id="btn-produce">생산</button>');
    });
    await listen(server);

    try {
        assert.equal(await isStaticServerAvailable(), true);
    } finally {
        await close(server);
    }
});

test('availability rejects a listener that never completes its response', async () => {
    let socket;
    let markRequestReceived;
    const requestReceived = new Promise((resolve) => { markRequestReceived = resolve; });
    const server = http.createServer(() => { markRequestReceived(true); });
    server.on('connection', (connection) => { socket = connection; });
    await listen(server);
    const probe = isStaticServerAvailable();
    const timedOut = Symbol('probe did not settle');

    try {
        const received = await Promise.race([
            requestReceived,
            new Promise((resolve) => setTimeout(() => resolve(false), 250)),
        ]);
        assert.equal(received, true);
        const result = await Promise.race([
            probe,
            new Promise((resolve) => setTimeout(() => resolve(timedOut), AVAILABILITY_TIMEOUT_MS + 500)),
        ]);
        assert.equal(result, false);
    } finally {
        socket?.destroy();
        await close(server);
    }
});

test('Playwright starts and tears down its owned server within 15 seconds', async () => {
    assert.equal(await isServerReachable(), false);

    const result = await runAccessibilityCli();

    assert.match(result.stdout, /1 passed/);
    assert.ok(result.elapsedMs < 15000);
    assert.equal(await isServerReachable(), false);
});

test('Playwright reuses an externally owned valid server without closing it', async () => {
    const server = await startStaticServer();

    try {
        const result = await runAccessibilityCli();
        assert.match(result.stdout, /1 passed/);
        assert.ok(result.elapsedMs < 15000);
        assert.equal(server.listening, true);
        assert.equal(await isServerReachable(), true);
    } finally {
        await stopStaticServer(server);
    }
});
