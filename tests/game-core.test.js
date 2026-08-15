import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, reduceGameState } from '../game-core.js';

test('Core State Engine - Initial State Defaults', () => {
    const state = createInitialState();
    assert.equal(state.productionUnits, 0);
    assert.equal(state.githubStars, 0);
    assert.equal(state.tunaCans, 0);
    assert.equal(state.techDebt, 0);
    assert.equal(state.threatMeter, 0);
    assert.equal(state.incidentCost, 0);
    assert.equal(state.endingTriggered, false);
    assert.equal(state.activeIntrusion, null);
    assert.equal(state.recoveryCount, 0);
});

test('Core State Engine - Produce Action 15:1 Ratio Contract', () => {
    let state = createInitialState();

    // 1st produce action: default 10 units -> 150 stars (15:1)
    state = reduceGameState(state, { type: 'PRODUCE' });
    assert.equal(state.productionUnits, 10);
    assert.equal(state.githubStars, 150);

    // Threat gain = 2 * 10 + floor(0/10) = 20
    assert.equal(state.threatMeter, 20);
});

test('Core State Engine - Fixed 500 Star Penalty Bounds', () => {
    let state = createInitialState();
    state.activeIntrusion = 'copilot';

    // Give 300 stars
    state.githubStars = 300;
    state = reduceGameState(state, { type: 'APPLY_AI_PENALTY' });
    assert.equal(state.githubStars, 0); // min(300, 500) -> 0, no negative stars

    // Reset intrusion & give 1000 stars
    state.activeIntrusion = 'copilot';
    state.githubStars = 1000;
    state = reduceGameState(state, { type: 'APPLY_AI_PENALTY' });
    assert.equal(state.githubStars, 500); // 1000 - 500 = 500
});

test('Core State Engine - Upgrade Cap +8 & Slot Max 2', () => {
    let state = createInitialState();
    state.githubStars = 1000;

    // Buy upgrade 1 ('coffee': +3 bonus, cost 300)
    state = reduceGameState(state, { type: 'BUY_UPGRADE', upgradeId: 'coffee' });
    assert.equal(state.activeUpgrades.length, 1);

    // Buy upgrade 2 ('server_rack': +5 bonus, cost 600)
    state = reduceGameState(state, { type: 'BUY_UPGRADE', upgradeId: 'server_rack' });
    assert.equal(state.activeUpgrades.length, 2);

    // Try buying duplicate upgrade -> rejected
    state = reduceGameState(state, { type: 'BUY_UPGRADE', upgradeId: 'coffee' });
    assert.equal(state.activeUpgrades.length, 2);

    // Verify produce uses total bonus +8 (10 + 8 = 18 units -> 270 stars)
    state.productionUnits = 0;
    state.githubStars = 0;
    state = reduceGameState(state, { type: 'PRODUCE' });
    assert.equal(state.productionUnits, 18);
    assert.equal(state.githubStars, 270);
});

test('Core State Engine - Recovery Mode Entry & Exit', () => {
    let state = createInitialState();
    state.productionUnits = 200;
    state.githubStars = 3000;

    state = reduceGameState(state, { type: 'RECOVER' });
    assert.equal(state.githubStars, 3150);
    assert.equal(state.endingTriggered, false);

    state.githubStars = 8999;
    state = reduceGameState(state, { type: 'RECOVER' });
    assert.equal(state.githubStars, 9000);
    assert.equal(state.endingTriggered, true);
});

test('Core State Engine - 3,000 Stars Defers Ending After Intrusion', () => {
    let state = createInitialState();
    state.productionUnits = 200;
    state.githubStars = 3000;
    state.activeIntrusion = 'copilot';

    state = reduceGameState(state, { type: 'RESOLVE_INTRUSION' });

    assert.equal(state.githubStars, 3000);
    assert.equal(state.endingTriggered, false);
});

test('Core State Engine - Active Intrusion Defers 9,000 Star Ending', () => {
    let state = createInitialState();
    state.productionUnits = 200;
    state.githubStars = 9000;
    state.activeIntrusion = 'copilot';

    state = reduceGameState(state, { type: 'PRODUCE' });
    assert.equal(state.endingTriggered, false);

    state = reduceGameState(state, { type: 'RESOLVE_INTRUSION' });
    assert.equal(state.endingTriggered, true);
});

test('Recovery cycle opens Copilot only after five valid recoveries', () => {
    let state = { ...createInitialState(), productionUnits: 200, githubStars: 3000 };

    for (let recovery = 1; recovery <= 4; recovery += 1) {
        state = reduceGameState(state, { type: 'RECOVER' });
        assert.equal(state.recoveryCount, recovery);
        assert.equal(state.activeIntrusion, null);
    }

    state = reduceGameState(state, { type: 'RECOVER' });
    assert.equal(state.githubStars, 3750);
    assert.equal(state.recoveryCount, 5);
    assert.equal(state.activeIntrusion, 'copilot');
});

test('Recovery cycle repeats existing intrusions in Copilot, Codex, Gemini, CEO order', () => {
    let state = { ...createInitialState(), productionUnits: 200, githubStars: 3000 };
    const expectedIntrusions = ['copilot', 'codex', 'gemini', 'ceo'];

    for (const expectedIntrusion of expectedIntrusions) {
        for (let recovery = 0; recovery < 5; recovery += 1) {
            state = reduceGameState(state, { type: 'RECOVER' });
        }
        assert.equal(state.activeIntrusion, expectedIntrusion);
        if (expectedIntrusion !== 'ceo') {
            state = reduceGameState(state, { type: 'RESOLVE_INTRUSION' });
        }
    }

    const shipped = reduceGameState(state, { type: 'RESOLVE_CEO_SHIP' });
    assert.equal(shipped.githubStars, 7000);
    assert.equal(shipped.techDebt, 30);

    const rejected = reduceGameState(state, { type: 'REJECT_CEO_ORDER' });
    assert.equal(rejected.githubStars, 5500);
    assert.equal(rejected.incidentCost, 500);
});

test('Recovery is blocked during an intrusion without advancing its cadence', () => {
    const state = {
        ...createInitialState(),
        productionUnits: 200,
        githubStars: 3750,
        recoveryCount: 5,
        activeIntrusion: 'copilot'
    };

    const blocked = reduceGameState(state, { type: 'RECOVER' });
    assert.deepEqual(blocked, state);
});

test('A fifth recovery reaching 9,000 stars defers ending until its intrusion is resolved', () => {
    let state = {
        ...createInitialState(),
        productionUnits: 200,
        githubStars: 8999,
        recoveryCount: 4
    };

    state = reduceGameState(state, { type: 'RECOVER' });
    assert.equal(state.githubStars, 9000);
    assert.equal(state.activeIntrusion, 'copilot');
    assert.equal(state.endingTriggered, false);

    state = reduceGameState(state, { type: 'RESOLVE_INTRUSION' });
    assert.equal(state.endingTriggered, true);
});
