import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, reduceGameState } from '../game-core.js';

test('Full Game Run - Happy Path (No upgrade, no penalty)', () => {
    let state = createInitialState();
    let clicks = 0;

    while (!state.endingTriggered && clicks < 60) {
        clicks++;
        if (state.activeIntrusion !== null) {
            state = reduceGameState(state, { type: 'RESOLVE_INTRUSION' });
        } else if (state.productionUnits >= 200 && state.githubStars < 3000) {
            state = reduceGameState(state, { type: 'RECOVER' });
        } else {
            state = reduceGameState(state, { type: 'PRODUCE' });
        }
    }

    assert.equal(state.productionUnits, 200);
    assert.equal(state.githubStars, 3000);
    assert.equal(state.endingTriggered, true);
});

test('Full Game Run - Upgrade Route (Buy Coffee upgrade, RECOVER to 3000 stars)', () => {
    let state = createInitialState();
    let clicks = 0;

    while (!state.endingTriggered && clicks < 60) {
        clicks++;

        // Buy coffee upgrade as soon as affordable (300 stars)
        if (state.activeUpgrades.length === 0 && state.githubStars >= 300 && state.activeIntrusion === null) {
            state = reduceGameState(state, { type: 'BUY_UPGRADE', upgradeId: 'coffee' });
        }

        if (state.activeIntrusion !== null) {
            state = reduceGameState(state, { type: 'RESOLVE_INTRUSION' });
        } else if (state.productionUnits >= 200 && state.githubStars < 3000) {
            // Must trigger RECOVER action!
            state = reduceGameState(state, { type: 'RECOVER' });
        } else {
            state = reduceGameState(state, { type: 'PRODUCE' });
        }
    }

    assert.equal(state.productionUnits, 200);
    assert.equal(state.githubStars, 3000);
    assert.equal(state.endingTriggered, true);
});

test('Full Game Run - Penalty Route (Accept AI Penalty -500★, RECOVER to 3000 stars)', () => {
    let state = createInitialState();
    let clicks = 0;

    while (!state.endingTriggered && clicks < 60) {
        clicks++;
        if (state.activeIntrusion !== null) {
            // Accept penalty once
            state = reduceGameState(state, { type: 'APPLY_AI_PENALTY' });
        } else if (state.productionUnits >= 200 && state.githubStars < 3000) {
            // Trigger RECOVER action to fill missing stars
            state = reduceGameState(state, { type: 'RECOVER' });
        } else {
            state = reduceGameState(state, { type: 'PRODUCE' });
        }
    }

    assert.equal(state.productionUnits, 200);
    assert.equal(state.githubStars, 3000);
    assert.equal(state.endingTriggered, true);
    assert.equal(state.incidentCost > 0, true);
});
