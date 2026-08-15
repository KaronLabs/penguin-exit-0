import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dialogueDecks, puzzles, upgrades } from '../content.js';

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

    assert.ok(puzzles.every(({ description, choices }) => /[가-힣]/.test(description) && choices.every(({ output }) => typeof output === 'string' && output.length > 0)), 'each Korean-first puzzle must provide terminal output for every choice');
    assert.deepEqual(
        puzzles.map(({ id, encounter }) => ({ id, encounter })),
        [
            { id: 'wifi', encounter: { name: 'Polar Bear DevOps', icon: '🐻', message: 'Wi-Fi는 살아났습니다. 참치 한 캔은 제 쪽에서 처리하죠.' } },
            { id: 'cpu', encounter: { name: 'Walrus DBA', icon: '🐘', message: '그건 백그라운드 작업이었다고 우기려 했는데… 들켰군요.' } },
            { id: 'ssh', encounter: { name: 'Sam Altman', icon: '🤖', message: 'I like your penguin hustle. 다음 open-source 프로젝트는 제가 투자하죠.' } }
        ]
    );
    assert.deepEqual(Object.fromEntries(Object.entries(dialogueDecks).map(([context, quotes]) => [context, quotes.length])), {
        puzzle: 18, repeat: 12, ai: 14, codeReview: 18
    });
    assert.deepEqual(dialogueDecks, {
        puzzle: [
            '내 할머니도 너보단 코딩을 잘하겠다.', '지식은 레버리지가 아니다 애송아.', '로그나 쳐 읽어라.', '서버 터지면 네 목통도 터진다.', 'p99 latency 먼저 확인하고 쳐라.', '지우지 마라. 네가 싼 똥(에러)을 똑바로 직시해라 ₩_₩', '이글루에서 당장 짐 싸서 나가라.', '네 뇌가 가비지 컬렉션(GC) 당한 거 아니냐?',
            '명령어를 고른 근거가 뭐냐? 네 손가락이 네 뇌보다 먼저 취업했냐?', '그건 해결책이 아니라 장애 보고서 첫 문장이다.', '재시작은 진단이 아니다. 생각을 껐다 켜는 건 네 머리로 충분하다.', '로그 세 줄 읽는 게 그렇게 힘드냐? 네 커리어는 한 줄로 끝나겠다.', '프로덕션에 기도문을 배포하지 마라. 로그는 읽고 울어라.', '지금 누른 건 버튼이 아니라 야근 확정 도장이다.', '원인 분석을 302로 리다이렉트했냐? 목적지가 왜 ‘감’이야?', '문제는 Wi-Fi가 아니라 네 사고 회로가 비행기 모드인 거다.', 'PID는 찾았는데 범인은 못 찾았네. 거울을 안 봤구나.', 'SSH 키를 뿌릴 거면 명함도 같이 뿌려라. 공격자가 연락하기 편하게.'
        ],
        repeat: [
            '에러 로그 안 읽냐? 네 눈은 장식이냐, 아니면 CSS냐?', '방금 네가 무지성으로 누른 그 엔터 한 번이 500달러짜리 장애다.', '지우지 마라. 네가 싼 똥(에러)을 똑바로 직시해라 ₩_₩', '원숭이한테 키보드 주고 바나나 주면서 치게 해도 너보단 에러 덜 낸다.', '침착해라. 마우스 부순다고 메모리 누수가 고쳐지진 않는다.', '네 뇌가 가비지 컬렉션(GC) 당한 거 아니냐?', '한 번 더 아무 생각 없이 누르면 네 SSH 접속 키를 날려버리겠다.',
            '또 눌렀네. 멱등성 테스트가 아니라 내 인내심 DDoS다.', '클릭 횟수로 실력이 늘었으면 네 마우스가 CTO였겠다.', '버튼을 세 번 누르면 근본 원인이 부끄러워서 자수할 줄 알았냐?', '연타하지 마라. 장애는 리듬게임이 아니다.', '네 손가락은 hot path인데 사고 과정은 아직 cold start다.'
        ],
        ai: [
            'AI가 짜준 코드 복붙하다가 서버 터지면 AI가 책임지냐? 네 목통이 터지는 거다.', '챗GPT한테 네 연봉도 대신 받아달라고 하지 그러냐?', 'Copilot이 짠 코드를 리뷰도 없이 푸시(Push)해? 넌 내일부터 Copilot의 키보드 받침대다.', 'AI 개싸움판에 낀 걸 환영한다. 근데 네가 제일 약해 보인다.', 'AGI가 오기 전에 너부터 대체되겠다. 아니, 이미 스크립트 5줄로 대체 가능할지도.', '오픈AI가 널 보면 인공지능이 아니라 인공지능 미만의 무언가로 분류할 거다.',
            'Copilot이 핸들을 잡았는데 넌 왜 조수석에서 코드 리뷰를 자고 있냐?', 'Codex가 finalFinalV7을 만들었다고? 네가 finalFinalV6까지 허락한 게 더 큰 죄다.', 'Gemini가 3초 생각하는 동안 넌 3년치 기술 부채를 만들었다.', 'AI 셋이 싸우는데 인간인 네 코드가 제일 먼저 탈락했다.', '프롬프트는 2천 자인데 요구사항은 실종됐다. 네 회의록도 이 모양이냐?', 'AI 출력에 초록 체크가 떴다고 진실이 된 줄 아냐? 신호등도 고장 난다.', '모델을 바꾸기 전에 질문부터 사람 말로 바꿔라.', '컨텍스트는 100만 토큰인데 네 핵심은 아직 로딩 중이다.'
        ],
        codeReview: [
            '내 할머니도 너보단 코딩을 잘하겠다.', '이딴 걸 코드라고 짰냐? 스파게티도 이거보단 논리적으로 꼬여있겠다.', '네 코드는 마치 윈도우 ME 같다. 존재 자체가 블루스크린이다.', '이딴 식으로 짤 거면 그냥 엑셀로 짜라. 그게 낫겠다.', '변수명이 data1, data2? 네 이름도 human1로 바꿔줄까?', '예외 처리(Exception Handling)를 try-catch로 다 삼켜버리네? 블랙홀이냐?', '네가 짠 코드를 보면 Linus Torvalds가 무덤에서 일어날 거다. (아직 안 죽었지만 널 패려고)', 'p99 latency 10ms 넘어가면 밥 굶을 준비 해라.', '롤백(Rollback) 플랜 없이 배포 버튼 누르는 놈은 내 팀에 필요 없다.', '모르면 추측하지 말고 strace를 걸어라. 추측은 버그의 어머니다.', '카나리 1% 배포 안 하고 프로덕션 직행? 네 인생도 카나리 없이 훅 갈 수 있다.',
            '네 코드에 타입은 없고 희망사항만 있다.', '이 커밋은 revert가 아니라 제사부터 지내야 한다.', 'null 체크를 안 했네. 네 커리어도 곧 undefined다.', 'O(N²)을 사랑하냐? CPU 팬이 네 러브레터에 답장 중이다.', '변수명 `tmp2_final_real`? 유언장도 버전 관리로 쓰냐?', '테스트가 초록색인 이유는 아무것도 검증하지 않아서다. 잔디밭이냐?', '네 PR은 리뷰가 아니라 목격자 진술이 필요하다.'
        ]
    });
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
