import { test, expect } from '@playwright/test';

const expectedStages = [
    '1단계 · 혹한 속 택배 상자',
    '2단계 · 이글루 차고 스타트업',
    '2.5단계 · 하이테크 이글루 스타트업',
    '3단계 · 남극 펭귄 연구소',
    '4단계 · 초거대 AI 데이터센터 CEO',
    '5단계 · 마이애미 해변의 AGI 재벌 · EXIT 0'
];
const expectedIntrusions = [
    { title: '🤖 Copilot 코드 침입!', body: 'Copilot이 반복되는 나쁜 코드를 생성했습니다! Esc 또는 git revert로 되돌리세요.' },
    { title: '🧠 Codex 타입 침입!', body: 'Codex가 변수명을 finalFinalV7로 바꿨습니다! unsafe_cast를 수정하세요.' },
    { title: '✨ Gemini 응답 지연!', body: 'Gemini가 응답을 생성 중입니다... 3초 후 자동 해제되며 Esc로도 해제할 수 있습니다.' },
    { title: '💼 CEO 금요일 17:59 배포 지시!', body: 'CEO가 즉시 프로덕션 배포를 요구합니다!' }
];

async function metrics(page) {
    return page.evaluate(() => ({
        units: Number.parseInt(document.querySelector('#val-units').textContent, 10),
        stars: Number.parseInt(document.querySelector('#val-stars').textContent, 10)
    }));
}

async function reachRecoverAndEnding(page) {
    const produce = page.locator('#btn-produce');
    const banner = page.locator('#intrusion-banner');
    const ending = page.locator('#ending-overlay');
    const stages = new Map();
    const intrusions = [];
    let recoverName = null;

    for (let step = 0; step < 80; step += 1) {
        const state = await metrics(page);
        if (await ending.isVisible()) break;
        if (await banner.isVisible()) {
            intrusions.push({
                title: await page.locator('#intrusion-title').innerText(),
                body: await page.locator('#intrusion-msg').innerText(),
                produceName: await produce.getAttribute('aria-label')
            });
            if (await page.locator('#btn-ceo-ship').isVisible()) await page.locator('#btn-revert').click();
            else await page.keyboard.press('Escape');
            continue;
        }
        if ([0, 40, 80, 120, 160, 200].includes(state.units)) stages.set(state.units, await page.locator('#stage-badge').innerText());
        if (state.units === 200 && state.stars < 3000) recoverName = await produce.getAttribute('aria-label');
        await produce.click();
    }

    return { stages: [...stages.values()], intrusions, recoverName, endingName: await produce.getAttribute('aria-label') };
}

test('초기 화면은 한국어 문서 언어와 랜드마크를 제공한다', async ({ page }) => {
    await page.goto('/');
    const fontProof = await page.evaluate(async () => {
        const family = 'JetBrainsMono Nerd Embedded';
        const sample = 'iiiiiiiiWWWWWW0011';
        const loadedFaces = await document.fonts.load(`500 32px "${family}"`, sample);
        await document.fonts.ready;
        const face = [...document.fonts].find((entry) => entry.family.replace(/^['"]|['"]$/g, '') === family);
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        context.font = `500 32px "${family}", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif`;
        const embeddedWidth = context.measureText(sample).width;
        context.font = '500 32px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif';
        const fallbackWidth = context.measureText(sample).width;
        return {
            loadedFaceCount: loadedFaces.length,
            faceStatus: face?.status ?? null,
            embeddedWidth,
            fallbackWidth,
            body: getComputedStyle(document.body).fontFamily,
            display: getComputedStyle(document.querySelector('h1')).fontFamily,
            utility: getComputedStyle(document.querySelector('.card-val')).fontFamily
        };
    });
    const contract = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        title: document.title,
        header: document.querySelector('header h1').textContent.trim(),
        subtitle: document.querySelector('header .sub').textContent.trim(),
        resources: [...document.querySelectorAll('.dashboard .card-title')].map((node) => node.textContent.trim()),
        dashboardAria: document.querySelector('.dashboard').getAttribute('aria-label'),
        panels: [...document.querySelectorAll('.panel h2')].map((node) => node.textContent.trim()),
        panelAria: [...document.querySelectorAll('.panel')].map((node) => node.getAttribute('aria-label')),
        tabs: [...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent.trim()),
        buttonText: document.querySelector('#btn-produce').textContent.trim(),
        buttonAria: document.querySelector('#btn-produce').getAttribute('aria-label')
    }));

    expect(contract).toEqual({
        lang: 'ko', title: '펭귄 EXIT 0 — 상업화 대작전 v2.1', header: '펭귄 EXIT 0',
        subtitle: 'AI 장애 복구 · SRE 기술 부채 생존기 · 상업화 대작전 v2.1',
        resources: ['생산량', 'GitHub 스타', '기술 부채', '위협도', '참치 캔', '장애 비용'],
        dashboardAria: '게임 자원 지표',
        panels: ['펭귄 피난처 단계', '장애 진단 터미널'], tabs: ['Wi-Fi 장애', 'CPU 장애', 'SSH 장애'],
        panelAria: ['펭귄 피난처 단계', '장애 진단 터미널'],
        buttonText: '💻 코드 작성 (+10 유닛 / +150★)', buttonAria: '코드 작성: 생산량 10과 GitHub 스타 150 획득'
    });
    expect(fontProof.loadedFaceCount).toBeGreaterThan(0);
    expect(fontProof.faceStatus).toBe('loaded');
    expect(Math.abs(fontProof.embeddedWidth - fontProof.fallbackWidth)).toBeGreaterThan(1);
    const firstFamily = (value) => value.split(',')[0].trim().replace(/^(['"])(.*)\1$/, '$2');
    expect(firstFamily(fontProof.body)).toBe('JetBrainsMono Nerd Embedded');
    expect(firstFamily(fontProof.display)).toBe('JetBrainsMono Nerd Embedded');
    expect(firstFamily(fontProof.utility)).toBe('JetBrainsMono Nerd Embedded');
});

test('퍼즐과 업그레이드는 한국어 설명과 원본 기술 토큰을 함께 제공한다', async ({ page }) => {
    await page.goto('/');
    const puzzles = [];
    for (const tabId of ['wifi', 'cpu', 'ssh']) {
        await page.locator(`[data-puz="${tabId}"]`).click();
        puzzles.push({
            title: await page.locator('#puzzle-title').innerText(),
            choices: await page.locator('.puzzle-option').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')))
        });
    }
    const upgrades = await page.locator('.upgrade-card').evaluateAll((cards) => cards.map((card) => ({
        name: card.querySelector('.upgrade-copy > .upgrade-name').textContent.trim(), description: card.querySelector('.upgrade-copy > .upgrade-description').textContent.trim(), button: card.querySelector('button').textContent.trim()
    })));
    expect(puzzles).toEqual([
        { title: '장애 #1: 사무실 Wi-Fi 연결 끊김', choices: ['1. ping 8.8.8.8 (안전한 SRE 진단)', '2. top / ip link (근본 원인 분석)', '3. systemctl restart nginx (무작정 재시작)'] },
        { title: '장애 #2: 서버 #4 고CPU 경보', choices: ['1. top / ip link show (PID 1337 점검)', '2. kill -9 1337 (마이너 종료)', '3. reboot (피크 시간 재부팅)'] },
        { title: '장애 #3: 골든 티켓 SSH 침입', choices: ['1. cat /var/log/auth.log (로그 감사)', '2. ssh-copy-id sam_altman (탐욕스러운 동맹)'] }
    ]);
    expect(upgrades).toEqual([
        { name: '[ESP] 북극곰 에스프레소 머신', description: '작업당 생산량이 +3 유닛 증가합니다.', button: '구매 (300★)' },
        { name: '[HPC] 바다코끼리 고성능 클러스터', description: '작업당 생산량이 +5 유닛 증가합니다.', button: '구매 (600★)' }
    ]);
});

test('동적 상태는 한국어 접근 이름과 엔딩 계약을 유지한다', async ({ page }) => {
    await page.goto('/');
    const initialName = await page.locator('#btn-produce').getAttribute('aria-label');
    const observed = await reachRecoverAndEnding(page);
    const endingText = await page.locator('#ending-overlay').innerText();

    expect(initialName).toBe('코드 작성: 생산량 10과 GitHub 스타 150 획득');
    expect(observed.stages).toEqual(expectedStages);
    expect(observed.intrusions.map(({ title, body }) => ({ title, body }))).toEqual(expectedIntrusions);
    expect(observed.intrusions.map(({ produceName }) => produceName)).toEqual([
        'AI 침입 대응 중: 생산 작업 잠김', 'AI 침입 대응 중: 생산 작업 잠김', 'AI 침입 대응 중: 생산 작업 잠김', 'AI 침입 대응 중: 생산 작업 잠김'
    ]);
    expect(observed.recoverName).toBe('RECOVER: 생산량 변화 없이 GitHub 스타 150 복구');
    expect(observed.endingName).toBe('EXIT 0 달성');
    expect(endingText).toContain('PROCESS EXIT CODE: 0');
    expect(endingText).toContain('FINANCIAL EXIT CODE: 1');
    expect(endingText).toContain('+$3,000');
    expect(endingText).toContain('-$3,001');
    expect(endingText).toContain('-$1');
});
