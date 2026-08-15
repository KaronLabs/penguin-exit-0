import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, reduceGameState } from '../game-core.js';

test('Remediation P0 - Defer ending on simultaneous intrusion at 200 units', () => {
    let state = createInitialState();
    state.productionUnits = 190;
    state.githubStars = 8850;
    state.threatMeter = 90;

    state = reduceGameState(state, { type: 'PRODUCE' });
    assert.equal(state.productionUnits, 200);
    assert.equal(state.githubStars, 9000);
    assert.notEqual(state.activeIntrusion, null);
    assert.equal(state.endingTriggered, false);

    state = reduceGameState(state, { type: 'RESOLVE_INTRUSION' });
    assert.equal(state.activeIntrusion, null);
    assert.equal(state.endingTriggered, true);
});

test('Remediation P1 - Idempotent AI Penalty (Reject duplicate penalty when no intrusion)', () => {
    let state = createInitialState();
    state.githubStars = 1000;
    state.activeIntrusion = 'copilot';

    state = reduceGameState(state, { type: 'APPLY_AI_PENALTY' });
    assert.equal(state.githubStars, 500);
    assert.equal(state.incidentCost, 500);
    assert.equal(state.activeIntrusion, null);

    state = reduceGameState(state, { type: 'APPLY_AI_PENALTY' });
    assert.equal(state.githubStars, 500);
    assert.equal(state.incidentCost, 500);
});

test('Remediation P1 - Reject negative tuna amounts', () => {
    let state = createInitialState();
    state = reduceGameState(state, { type: 'ADD_TUNA', amount: -1 });
    assert.equal(state.tunaCans, 0);
});

test('Remediation P1 - Reject forged upgrade payloads', () => {
    let state = createInitialState();
    state.githubStars = 0;

    const forged = { id: 'hacked', costStars: -1000, bonus: 999 };
    state = reduceGameState(state, { type: 'BUY_UPGRADE', upgradeId: forged.id });

    assert.equal(state.activeUpgrades.length, 0);
    assert.equal(state.githubStars, 0);
});

test('Remediation P1 - Threat Meter clamped at max 99', () => {
    let state = createInitialState();
    state.techDebt = 100;
    state.threatMeter = 90;

    state = reduceGameState(state, { type: 'PRODUCE' });
    assert.equal(state.threatMeter <= 99, true);
});

test('CEO reject charges exactly 500 stars and clears only CEO intrusion', () => {
    const ceoState = { ...createInitialState(), githubStars: 1950, activeIntrusion: 'ceo' };
    const rejected = reduceGameState(ceoState, { type: 'REJECT_CEO_ORDER' });
    assert.equal(rejected.githubStars, 1450);
    assert.equal(rejected.incidentCost, 500);
    assert.equal(rejected.activeIntrusion, null);

    const nonCeo = { ...ceoState, activeIntrusion: 'gemini' };
    assert.strictEqual(reduceGameState(nonCeo, { type: 'REJECT_CEO_ORDER' }), nonCeo);
});

test('generic resolution never applies a hidden star penalty', () => {
    const state = { ...createInitialState(), githubStars: 1950, activeIntrusion: 'gemini' };
    const resolved = reduceGameState(state, { type: 'RESOLVE_INTRUSION' });
    assert.equal(resolved.githubStars, 1950);
    assert.equal(resolved.incidentCost, 0);
});
