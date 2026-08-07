import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { puzzles, upgrades } from '../content.js';

const styles = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

const expectedPuzzles = [
    { id: 'wifi', title: '장애 #1: 사무실 Wi-Fi 연결 끊김', choices: [
        { key: 'ping', cmd: 'ping 8.8.8.8', label: '1. ping 8.8.8.8 (안전한 SRE 진단)', rewardTuna: 1, techDebtPercent: 0 },
        { key: 'top', cmd: 'top / ip link', label: '2. top / ip link (근본 원인 분석)', rewardTuna: 2, techDebtPercent: 0 },
        { key: 'systemctl', cmd: 'systemctl restart nginx', label: '3. systemctl restart nginx (무작정 재시작)', rewardTuna: 0, techDebtPercent: 15 }
    ] },
    { id: 'cpu', title: '장애 #2: 서버 #4 고CPU 경보', choices: [
        { key: 'ip_link', cmd: 'ip link show / top', label: '1. top / ip link show (PID 1337 점검)', rewardTuna: 1, techDebtPercent: 0 },
        { key: 'kill', cmd: 'kill -9 1337', label: '2. kill -9 1337 (마이너 종료)', rewardTuna: 2, techDebtPercent: 0 },
        { key: 'reboot', cmd: 'reboot', label: '3. reboot (피크 시간 재부팅)', rewardTuna: 0, techDebtPercent: 20 }
    ] },
    { id: 'ssh', title: '장애 #3: 골든 티켓 SSH 침입', choices: [
        { key: 'auth_log', cmd: 'cat /var/log/auth.log', label: '1. cat /var/log/auth.log (로그 감사)', rewardTuna: 1, techDebtPercent: 0 },
        { key: 'altman', cmd: 'ssh-copy-id sam_altman', label: '2. ssh-copy-id sam_altman (탐욕스러운 동맹)', rewardTuna: 2, techDebtPercent: 25 }
    ] }
];

test('콘텐츠는 한국어 우선이며 명령어와 보상 계약을 보존한다', () => {
    assert.deepEqual(
        puzzles.map(({ id, title, choices }) => ({
            id, title,
            choices: choices.map(({ key, cmd, label, rewardTuna, techDebtPercent }) => ({ key, cmd, label, rewardTuna, techDebtPercent }))
        })),
        expectedPuzzles
    );
    const dataPrefix = 'src: url("data:font/ttf;base64,';
    const dataStart = styles.indexOf(dataPrefix);
    const dataEnd = styles.indexOf('") format("truetype");', dataStart);
    assert.ok(styles.includes('@font-face {'), 'embedded font must be declared through @font-face');
    assert.ok(styles.includes('font-family: "JetBrainsMono Nerd Embedded";'), 'embedded font must use the internal web family');
    assert.notEqual(dataStart, -1, 'embedded font must use a font/ttf base64 data URI');
    assert.notEqual(dataEnd, -1, 'embedded font data URI must declare truetype format');
    const fontBytes = Buffer.from(styles.slice(dataStart + dataPrefix.length, dataEnd), 'base64');
    assert.equal(fontBytes.length, 2468976, 'embedded TTF byte length must match the installed source');
    assert.equal(createHash('sha256').update(fontBytes).digest('hex').toUpperCase(), '04A099702E3E808A922C28C4A4DA656E9EA783D6FA6BED33AE67F6F4E0AFB937');
    assert.ok(styles.includes('--font-display: "JetBrainsMono Nerd Embedded", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif;'), 'display font role must lead with the embedded family');
    assert.ok(styles.includes('--font-body: "JetBrainsMono Nerd Embedded", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif;'), 'body font role must lead with the embedded family');
    assert.ok(styles.includes('--font-utility: "JetBrainsMono Nerd Embedded", "Malgun Gothic", Consolas, "SFMono-Regular", "Liberation Mono", monospace;'), 'utility font role must lead with the embedded family and preserve Hangul fallback');
});

test('업그레이드는 관제 배지와 비용·보너스를 보존한다', () => {
    assert.deepEqual(
        upgrades.map(({ id, name, description, costStars, bonus }) => ({ id, name, description, costStars, bonus })),
        [
            { id: 'coffee', name: '[ESP] 북극곰 에스프레소 머신', description: '작업당 생산량이 +3 유닛 증가합니다.', costStars: 300, bonus: 3 },
            { id: 'server_rack', name: '[HPC] 바다코끼리 고성능 클러스터', description: '작업당 생산량이 +5 유닛 증가합니다.', costStars: 600, bonus: 5 }
        ]
    );
});
