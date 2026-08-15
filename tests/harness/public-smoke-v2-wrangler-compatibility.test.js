import assert from 'node:assert/strict';
import test from 'node:test';
import { validateOwnershipRow } from '../../scripts/operator-deploy-public-smoke-v2.mjs';

const config = {
    projectName: 'penguin-exit-0',
    accountId: '0123456789abcdef0123456789abcdef',
    sourceGitHead: '349573e9a4fc3006db71c823a0571dfe9ec26847',
};

const row = {
    Id: '11111111-1111-4111-8111-111111111111',
    Environment: 'Production',
    Branch: 'main',
    Source: '349573e',
    Deployment: 'https://11111111.penguin-exit-0.pages.dev/',
    Status: '2 days ago',
    Build: 'https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/pages/view/penguin-exit-0/11111111-1111-4111-8111-111111111111',
};

test('operator accepts the pinned Wrangler 4.121 successful deployment-list JSON row', () => {
    assert.deepEqual(validateOwnershipRow(row, config, 'operator.live'), row);
});

test('operator rejects failed status and a dashboard URL for another account', () => {
    assert.throws(() => validateOwnershipRow({ ...row, Status: 'Failure' }, config, 'operator.live'), /operator\.live/);
    assert.throws(() => validateOwnershipRow({ ...row, Build: row.Build.replace(config.accountId, 'f'.repeat(32)) }, config, 'operator.live'), /operator\.live/);
});
