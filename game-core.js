/**
 * Penguin EXIT 0 Commercial Edition v2.1 - Pure State Engine (game-core.js)
 * Zero DOM Dependency, Pure State Reducer & Strict Invariants (Final Acquittal Edition)
 */

import { upgrades } from './content.js';

export const STAR_TARGET = 9000;

export function createInitialState(seed = 'default-seed') {
    return {
        productionUnits: 0,
        githubStars: 0,
        tunaCans: 0,
        techDebt: 0,
        threatMeter: 0,
        incidentCost: 0,
        activeUpgrades: [],
        activeIntrusion: null, // null | 'copilot' | 'codex' | 'gemini' | 'ceo'
        endingTriggered: false,
        intrusionCount: 0,
        recoveryCount: 0,
        seed: seed
    };
}

export function reduceGameState(state, action) {
    if (state.endingTriggered) {
        return state; // State lock on ending
    }

    const nextState = {
        ...state,
        activeUpgrades: [...state.activeUpgrades]
    };

    switch (action.type) {
        case 'PRODUCE': {
            if (nextState.activeIntrusion !== null) {
                return state; // Block production while intrusion active
            }

            const totalBonus = nextState.activeUpgrades.reduce((sum, up) => sum + up.bonus, 0);
            const unitBonus = Math.min(8, totalBonus);
            const effectiveUnits = Math.min(200 - nextState.productionUnits, 10 + unitBonus);

            if (effectiveUnits <= 0) {
                return state; // No units left to produce
            }

            nextState.productionUnits += effectiveUnits;
            nextState.githubStars = Math.min(STAR_TARGET, nextState.githubStars + effectiveUnits * 15);

            // Threat formula: 2 * effectiveUnits + floor(techDebt / 10)
            const threatGain = 2 * effectiveUnits + Math.floor(nextState.techDebt / 10);
            nextState.threatMeter += threatGain;

            if (nextState.threatMeter >= 100 && nextState.intrusionCount < 4) {
                nextState.threatMeter = Math.min(99, nextState.threatMeter - 100);
                
                // Sequence of AI models: copilot -> codex -> gemini -> ceo
                const intrusionTypes = ['copilot', 'codex', 'gemini', 'ceo'];
                nextState.activeIntrusion = intrusionTypes[nextState.intrusionCount % intrusionTypes.length];
                nextState.intrusionCount += 1;
            } else {
                nextState.threatMeter = Math.min(99, nextState.threatMeter);
            }

            // Defer ending if intrusion is currently active
            if (nextState.productionUnits >= 200 && nextState.githubStars >= STAR_TARGET && nextState.activeIntrusion === null) {
                nextState.endingTriggered = true;
            }
            break;
        }

        case 'RESOLVE_INTRUSION': {
            if (nextState.activeIntrusion === null) {
                return state;
            }
            nextState.activeIntrusion = null;

            // Check deferred ending after intrusion resolution
            if (nextState.productionUnits >= 200 && nextState.githubStars >= STAR_TARGET) {
                nextState.endingTriggered = true;
            }
            break;
        }

        case 'REJECT_CEO_ORDER': {
            if (nextState.activeIntrusion !== 'ceo') {
                return state; // Only valid for CEO intrusion
            }
            const actualLoss = Math.min(nextState.githubStars, 500);
            nextState.githubStars -= actualLoss;
            nextState.incidentCost += actualLoss;
            nextState.activeIntrusion = null;

            if (nextState.productionUnits >= 200 && nextState.githubStars >= STAR_TARGET) {
                nextState.endingTriggered = true;
            }
            break;
        }

        case 'RESOLVE_CEO_SHIP': {
            if (nextState.activeIntrusion !== 'ceo') {
                return state;
            }
            nextState.activeIntrusion = null;
            nextState.githubStars = Math.min(STAR_TARGET, nextState.githubStars + 1000);
            nextState.techDebt = Math.min(100, nextState.techDebt + 30);

            if (nextState.productionUnits >= 200 && nextState.githubStars >= STAR_TARGET) {
                nextState.endingTriggered = true;
            }
            break;
        }

        case 'APPLY_AI_PENALTY': {
            if (nextState.activeIntrusion === null) {
                return state; // Idempotent: Ignore penalty call if no intrusion is active
            }
            const actualLoss = Math.min(nextState.githubStars, 500);
            nextState.githubStars -= actualLoss;
            nextState.incidentCost += actualLoss;
            nextState.activeIntrusion = null;

            if (nextState.productionUnits >= 200 && nextState.githubStars >= STAR_TARGET) {
                nextState.endingTriggered = true;
            }
            break;
        }

        case 'BUY_UPGRADE': {
            if (nextState.activeUpgrades.length >= 2) {
                return state; // Max 2 slots
            }
            const targetUpgrade = upgrades.find(u => u.id === action.upgradeId);
            if (!targetUpgrade) {
                return state;
            }
            if (nextState.activeUpgrades.some(u => u.id === targetUpgrade.id)) {
                return state;
            }

            if (nextState.githubStars >= targetUpgrade.costStars) {
                nextState.githubStars -= targetUpgrade.costStars;
                nextState.activeUpgrades.push(targetUpgrade);
            }
            break;
        }

        case 'RECOVER': {
            if (nextState.productionUnits >= 200 && nextState.githubStars < STAR_TARGET && nextState.activeIntrusion === null) {
                const recoveryGain = Math.min(150, STAR_TARGET - nextState.githubStars);
                nextState.githubStars += recoveryGain;
                nextState.recoveryCount = (nextState.recoveryCount || 0) + 1;

                if (nextState.recoveryCount % 5 === 0) {
                    const intrusionTypes = ['copilot', 'codex', 'gemini', 'ceo'];
                    const cycleIndex = (nextState.recoveryCount / 5 - 1) % intrusionTypes.length;
                    nextState.activeIntrusion = intrusionTypes[cycleIndex];
                }

                if (nextState.githubStars >= STAR_TARGET && nextState.activeIntrusion === null) {
                    nextState.endingTriggered = true;
                }
            }
            break;
        }

        case 'ADD_TUNA': {
            const validAmount = Math.max(0, action.amount || 0);
            nextState.tunaCans = Math.min(3, Math.max(0, nextState.tunaCans + validAmount));
            break;
        }

        case 'ADD_TECH_DEBT': {
            const validPercent = Math.max(0, action.percent || 0);
            nextState.techDebt = Math.min(100, Math.max(0, nextState.techDebt + validPercent));
            break;
        }
    }

    return nextState;
}
