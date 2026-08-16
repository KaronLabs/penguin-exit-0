import test from 'node:test';
import assert from 'node:assert/strict';
import { puzzles, upgrades } from '../content.js';
import { createInitialState, reduceGameState } from '../game-core.js';

test('Puzzle Content Registry - Fair SRE Diagnostics for WiFi', () => {
    const wifiPuzzle = puzzles.find(p => p.id === 'wifi');
    assert.notEqual(wifiPuzzle, undefined);

    // 'top' choice must be marked as fair diagnostic option (no false negative)
    const topChoice = wifiPuzzle.choices.find(c => c.key === 'top');
    assert.notEqual(topChoice, undefined);
    assert.equal(topChoice.isFairDiagnostic, true);
    assert.equal(topChoice.rewardTuna, 2);
});

test('Puzzle Content Registry - Fair SRE Diagnostics for High CPU & SSH', () => {
    const cpuPuzzle = puzzles.find(p => p.id === 'cpu');
    const sshPuzzle = puzzles.find(p => p.id === 'ssh');

    const ipLinkChoice = cpuPuzzle.choices.find(c => c.key === 'ip_link');
    assert.equal(ipLinkChoice.isFairDiagnostic, true);
    assert.equal(ipLinkChoice.rewardTuna, 0);
    assert.equal(ipLinkChoice.showEncounter, false);
    assert.equal(ipLinkChoice.nextStage, 'diagnosed');

    const killChoice = cpuPuzzle.choices.find(c => c.key === 'kill');
    assert.equal(killChoice.requiresStage, 'diagnosed');
    assert.deepEqual(killChoice.prematureResult, {
        isFairDiagnostic: false,
        rewardTuna: 0,
        techDebtPercent: 20,
        forfeitsReward: true,
        output: 'PID 검증 없이 kill -9 1337을 실행했습니다.\nCPU는 내려갔지만 변경 관리와 감사 절차가 사망했습니다.'
    });

    const rebootChoice = cpuPuzzle.choices.find(c => c.key === 'reboot');
    assert.equal(rebootChoice.forfeitsReward, true);

    const authLogChoice = sshPuzzle.choices.find(c => c.key === 'auth_log');
    assert.equal(authLogChoice.isFairDiagnostic, true);

    const allianceChoice = sshPuzzle.choices.find(c => c.key === 'altman');
    assert.equal(allianceChoice.rewardTuna, 3);
    assert.equal(allianceChoice.resultPresentation.summary, '참치 +3 · 기술 부채 +25%');
});
