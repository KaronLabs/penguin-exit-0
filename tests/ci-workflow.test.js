import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('CI runs the locked Node and three-browser test contract in order', () => {
    const runCommands = [...workflow.matchAll(/^\s*- run: (.+)$/gm)].map(([, command]) => command);

    assert.deepEqual(runCommands, [
        'npm ci',
        'npx playwright install --with-deps',
        'npm test',
        'npm run test:browser'
    ]);
    assert.equal(packageJson.scripts['test:browser'], 'playwright test --project=chromium --project=firefox --project=webkit');
});
