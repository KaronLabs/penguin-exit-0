import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, reduceGameState } from '../game-core.js';

test('AI Intrusion Guards - Single Intrusion Active & Production Blocked', () => {
    let state = createInitialState();
    state.activeIntrusion = 'copilot';

    // Production action must be blocked when intrusion is active
    const nextState = reduceGameState(state, { type: 'PRODUCE' });
    assert.equal(nextState.productionUnits, 0);
    assert.equal(nextState.githubStars, 0);
});

test('AI Intrusion Guards - Single Ending Execution Lock', () => {
    let state = createInitialState();
    state.endingTriggered = true;
    state.productionUnits = 200;
    state.githubStars = 3000;

    // Mutating actions after ending triggered must return exact same state object (lock)
    const state2 = reduceGameState(state, { type: 'PRODUCE' });
    assert.equal(state2, state);

    const state3 = reduceGameState(state, { type: 'APPLY_AI_PENALTY' });
    assert.equal(state3, state);
});

test('AI Intrusion Guards - Fifth Threshold Crossing Produces No Repeat Intrusion', () => {
    let state = createInitialState();
    state.threatMeter = 99;
    state.intrusionCount = 4;

    const nextState = reduceGameState(state, { type: 'PRODUCE' });
    assert.ok(nextState.productionUnits > 0);
    assert.equal(nextState.activeIntrusion, null);
    assert.equal(nextState.intrusionCount, 4);
    assert.ok(nextState.threatMeter <= 99);
});
