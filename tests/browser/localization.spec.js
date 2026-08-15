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
const firstPuzzleChoices = [
    { tabId: 'wifi', optionIndex: 0, command: 'ping 8.8.8.8', output: '64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=14.2 ms\n케이블이 빠져 있었습니다. 네트워크를 복구했습니다.', tuna: '1 / 3', debt: '0%', npc: { icon: '🐻', name: 'Polar Bear DevOps', message: 'Wi-Fi는 살아났습니다. 참치 한 캔은 제 쪽에서 처리하죠.' } },
    { tabId: 'wifi', optionIndex: 1, command: 'top / ip link', output: 'eth0: state DOWN\n링크 상태와 라우팅을 함께 확인했습니다. 범인은 케이블입니다.', tuna: '2 / 3', debt: '0%', npc: { icon: '🐻', name: 'Polar Bear DevOps', message: 'Wi-Fi는 살아났습니다. 참치 한 캔은 제 쪽에서 처리하죠.' } },
    { tabId: 'wifi', optionIndex: 2, command: 'systemctl restart nginx', output: 'Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.', tuna: '0 / 3', debt: '15%', npc: null },
    { tabId: 'cpu', optionIndex: 0, command: 'ip link show / top', output: 'PID 1337 xmrig가 CPU 99.9%를 점유 중입니다. 프로세스와 네트워크를 확인했습니다.', tuna: '1 / 3', debt: '0%', npc: { icon: '🐘', name: 'Walrus DBA', message: '그건 백그라운드 작업이었다고 우기려 했는데… 들켰군요.' } },
    { tabId: 'cpu', optionIndex: 1, command: 'kill -9 1337', output: '[1] + Killed xmrig\nCPU 사용량이 2%로 떨어졌습니다. 프로덕션을 살렸습니다.', tuna: '2 / 3', debt: '0%', npc: { icon: '🐘', name: 'Walrus DBA', message: '그건 백그라운드 작업이었다고 우기려 했는데… 들켰군요.' } },
    { tabId: 'cpu', optionIndex: 2, command: 'reboot', output: '피크 시간에 DB를 재부팅했습니다. CEO가 전화 중입니다.', tuna: '0 / 3', debt: '20%', npc: null },
    { tabId: 'ssh', optionIndex: 0, command: 'cat /var/log/auth.log', output: 'Accepted publickey for sam_altman from 192.168.x.x\n로그에 낯익은 이름이 있습니다.', tuna: '1 / 3', debt: '0%', npc: { icon: '🤖', name: 'Sam Altman', message: 'I like your penguin hustle. 다음 open-source 프로젝트는 제가 투자하죠.' } },
    { tabId: 'ssh', optionIndex: 1, command: 'ssh-copy-id sam_altman', output: 'Key installed. OpenAI로 향하는 보안 터널을 연결했습니다.', tuna: '2 / 3', debt: '25%', npc: { icon: '🤖', name: 'Sam Altman', message: 'I like your penguin hustle. 다음 open-source 프로젝트는 제가 투자하죠.' } }
];

async function puzzleRuntimeSnapshot(page) {
    return page.evaluate(() => {
        const quoteText = document.querySelector('#quote-collection').textContent;
        const npcCard = document.querySelector('#npc-card');
        return {
            terminalLines: [...document.querySelector('#terminal-output').children].map((node) => ({
                kind: node.dataset.terminalKind,
                context: node.dataset.dialogueContext ?? null,
                text: node.textContent
            })),
            tuna: document.querySelector('#val-tuna').textContent,
            debt: document.querySelector('#val-debt').textContent,
            quoteText,
            quoteCount: Number.parseInt(quoteText.match(/\d+(?=\/62$)/)[0], 10),
            npc: npcCard.hidden ? null : {
                icon: document.querySelector('#npc-icon').textContent,
                name: document.querySelector('#npc-name').textContent,
                message: document.querySelector('#npc-message').textContent
            }
        };
    });
}

async function metrics(page) {
    return page.evaluate(() => ({
        units: Number.parseInt(document.querySelector('#val-units').textContent, 10),
        stars: Number.parseInt(document.querySelector('#val-stars').textContent, 10)
    }));
}

async function reachRecoverAndEnding(page, beforeRecovery = null) {
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
            if (await page.locator('#btn-ceo-ship').isVisible()) await page.locator('#btn-revert').click();
            else await page.keyboard.press('Escape');
            continue;
        }
        if ([0, 40, 80, 120, 160, 200].includes(state.units)) stages.set(state.units, await page.locator('#stage-badge').innerText());
        let recoveryHandled = false;
        if (state.units === 200 && state.stars < 3000) {
            recoverName = await produce.getAttribute('aria-label');
            if (beforeRecovery) recoveryHandled = await beforeRecovery();
        }
        const aiQuotesBefore = await page.locator('#terminal-output [data-dialogue-context="ai"]').count();
        if (!recoveryHandled) await produce.click();
        if (await banner.isVisible()) {
            intrusions.push({
                title: await page.locator('#intrusion-title').innerText(),
                body: await page.locator('#intrusion-msg').innerText(),
                produceName: await produce.getAttribute('aria-label'),
                aiQuoteDelta: (await page.locator('#terminal-output [data-dialogue-context="ai"]').count()) - aiQuotesBefore
            });
            if (await page.locator('#btn-ceo-ship').isVisible()) await page.locator('#btn-revert').click();
            else await page.keyboard.press('Escape');
        }
    }

    return { stages: [...stages.values()], intrusions, recoverName, endingName: await produce.getAttribute('aria-label') };
}

test('초기 화면은 한국어 문서 언어와 랜드마크를 제공한다', async ({ page }) => {
    await page.goto('/');
    if (process.env.LOCALIZATION_MUTATION === 'terminal-hierarchy') {
        await page.addStyleTag({ content: `
            #terminal-output [data-terminal-kind="command"] { margin-top: 0 !important; }
            #terminal-output [data-terminal-kind="archon"] {
                font-size: 0.76rem !important;
                line-height: 1.45 !important;
                padding: 0 !important;
                border-left-width: 0 !important;
            }
            #terminal-output [data-terminal-kind="archon"]::before { display: inline !important; }
        ` });
    } else if (process.env.LOCALIZATION_MUTATION === 'archon-label-hidden') {
        await page.addStyleTag({ content: '#terminal-output [data-terminal-kind="archon"]::before { visibility: hidden !important; }' });
    }
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
    await expect(page.locator('#terminal-output')).toHaveAttribute('role', 'log');
    await expect(page.locator('#terminal-output')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#quote-collection')).toHaveText('아콘 독설 수집 0/62');
    await page.locator('[data-puz="wifi"]').click();
    await page.locator('.puzzle-option').nth(2).click();
    await expect(page.locator('#terminal-output')).toContainText('archon@stone-igloo:~$ systemctl restart nginx');
    await expect(page.locator('#terminal-output')).not.toContainText('Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.');
    await page.waitForTimeout(500);
    await expect(page.locator('#terminal-output')).toContainText('Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.');
    await page.waitForTimeout(600);
    await expect(page.locator('#terminal-output')).toContainText('내 할머니도 너보단 코딩을 잘하겠다.');
    const commandLine = page.locator('#terminal-output > *').filter({ hasText: 'archon@stone-igloo:~$ systemctl restart nginx' });
    const systemLine = page.locator('#terminal-output > *').filter({ hasText: 'Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.' });
    const archonLine = page.locator('#terminal-output > *').filter({ hasText: '내 할머니도 너보단 코딩을 잘하겠다.' });
    await expect(commandLine).toHaveCount(1);
    await expect(systemLine).toHaveCount(1);
    await expect(archonLine).toHaveCount(1);
    await expect(archonLine).toHaveText('아콘 🐧 // 내 할머니도 너보단 코딩을 잘하겠다.');
    const terminalKinds = await page.locator('#terminal-output').evaluate((terminal) => {
        const command = [...terminal.children].find((line) => line.textContent.startsWith('archon@stone-igloo:~$'));
        const system = [...terminal.children].find((line) => line.textContent.includes('Nginx를 재시작했지만'));
        const archon = [...terminal.children].find((line) => line.textContent.includes('내 할머니도 너보단'));
        const inspect = (line, pseudo = false) => {
            const style = getComputedStyle(line, pseudo ? '::before' : null);
            return {
                kind: line.dataset.terminalKind,
                color: style.color,
                weight: style.fontWeight,
                background: style.backgroundColor,
                borderLeftWidth: style.borderLeftWidth,
                borderLeftStyle: style.borderLeftStyle,
                borderLeftColor: style.borderLeftColor,
                fontSize: style.fontSize,
                lineHeight: style.lineHeight,
                marginTop: style.marginTop,
                padding: style.padding,
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                pseudo: pseudo ? style.content : null
            };
        };
        return { command: inspect(command), system: inspect(system), archon: inspect(archon), archonLabel: inspect(archon, true) };
    });
    expect(terminalKinds.command).toMatchObject({ kind: 'command', color: 'rgb(84, 199, 236)', weight: '700' });
    expect(terminalKinds.system).toMatchObject({ kind: 'system', color: 'rgb(148, 163, 184)', weight: '400' });
    expect(terminalKinds.archon).toMatchObject({
        kind: 'archon', color: 'rgb(255, 228, 232)', weight: '700', background: 'rgb(26, 16, 24)',
        borderLeftWidth: '3px', borderLeftStyle: 'solid', borderLeftColor: 'rgb(255, 101, 122)', padding: '8px'
    });
    expect(terminalKinds.command.marginTop).toBe('8px');
    expect(terminalKinds.archon.background).not.toBe(terminalKinds.command.background);
    expect(terminalKinds.archon.background).not.toBe(terminalKinds.system.background);
    expect(Number.parseFloat(terminalKinds.archon.fontSize)).toBeGreaterThan(Number.parseFloat(terminalKinds.system.fontSize));
    expect(Number.parseFloat(terminalKinds.archon.lineHeight) / Number.parseFloat(terminalKinds.archon.fontSize)).toBeCloseTo(1.58, 2);
    expect(terminalKinds.archonLabel).toMatchObject({
        color: 'rgb(246, 184, 63)', display: 'block', visibility: 'visible', opacity: '1', pseudo: '"ARCHON // ROAST"'
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('[data-puz="wifi"]').click();
    for (let click = 0; click < 30; click += 1) await page.locator('.puzzle-option').nth(2).click();
    await expect.poll(() => page.locator('#terminal-output > *').count()).toBe(80);
    await expect(page.locator('#terminal-output')).toContainText('아콘 🐧 // 또 눌렀네. 멱등성 테스트가 아니라 내 인내심 DDoS다.');
    const terminalViewport = await page.locator('#terminal-output').evaluate((terminal) => {
        const last = terminal.lastElementChild;
        const terminalRect = terminal.getBoundingClientRect();
        const lastRect = last.getBoundingClientRect();
        return {
            atBottom: terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 1,
            lastVisible: lastRect.top >= terminalRect.top - 1 && lastRect.bottom <= terminalRect.bottom + 1,
            lastText: last.textContent
        };
    });
    expect.soft(terminalViewport.atBottom).toBe(true);
    expect.soft(terminalViewport.lastVisible).toBe(true);
    expect.soft(terminalViewport.lastText.startsWith('아콘 🐧 // ')).toBe(true);
});

test('최초 퍼즐 선택은 명령 결과 독설과 경제 결과를 함께 남긴다', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });

    for (const fixture of firstPuzzleChoices) {
        await page.goto('/');
        await page.evaluate(() => localStorage.clear());
        await page.reload();
        await page.locator(`[data-puz="${fixture.tabId}"]`).click();
        await page.locator('.puzzle-option').nth(fixture.optionIndex).click();

        const snapshot = await puzzleRuntimeSnapshot(page);
        expect.soft(snapshot, fixture.command).toEqual({
            terminalLines: [
                { kind: 'command', context: null, text: `archon@stone-igloo:~$ ${fixture.command}` },
                { kind: 'system', context: null, text: fixture.output },
                expect.objectContaining({ kind: 'archon', context: 'puzzle', text: expect.stringMatching(/^아콘 🐧 \/\/ .+$/) })
            ],
            tuna: fixture.tuna,
            debt: fixture.debt,
            quoteText: '아콘 독설 수집 1/62',
            quoteCount: 1,
            npc: fixture.npc
        });
    }
});

test('반복 퍼즐 선택은 모든 경로에서 경제를 다시 적용하지 않고 repeat 독설을 남긴다', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });

    for (const fixture of firstPuzzleChoices) {
        await page.goto('/');
        await page.evaluate(() => localStorage.clear());
        await page.reload();
        await page.locator(`[data-puz="${fixture.tabId}"]`).click();
        const option = page.locator('.puzzle-option').nth(fixture.optionIndex);

        await option.click();
        const firstSnapshot = await puzzleRuntimeSnapshot(page);
        await option.click();
        const repeatSnapshot = await puzzleRuntimeSnapshot(page);

        expect.soft({
            tail: repeatSnapshot.terminalLines.slice(-3),
            quoteDelta: repeatSnapshot.quoteCount - firstSnapshot.quoteCount,
            economy: [firstSnapshot.tuna, firstSnapshot.debt, repeatSnapshot.tuna, repeatSnapshot.debt]
        }, fixture.command).toEqual({
            tail: [
                { kind: 'command', context: null, text: `archon@stone-igloo:~$ ${fixture.command}` },
                { kind: 'system', context: null, text: fixture.output },
                expect.objectContaining({ kind: 'archon', context: 'repeat', text: expect.stringMatching(/^아콘 🐧 \/\/ .+$/) })
            ],
            quoteDelta: 1,
            economy: [fixture.tuna, fixture.debt, fixture.tuna, fixture.debt]
        });
    }
});

test('탭 전환은 진행 중인 퍼즐 결과와 독설을 취소하지 않는다', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.locator('[data-puz="wifi"]').click();
    await page.evaluate(() => {
        const targets = new Map([
            [document.querySelector('.puzzle-option:nth-child(3)'), 'wifi-systemctl'],
            [document.querySelector('[data-puz="cpu"]'), 'cpu-tab']
        ]);
        window.__r14ClickEvents = [];
        document.addEventListener('click', (event) => {
            const target = targets.get(event.target);
            if (target) window.__r14ClickEvents.push({ target, timeStamp: event.timeStamp, isTrusted: event.isTrusted });
        }, { capture: true });
    });

    await page.locator('.puzzle-option').nth(2).click();
    await page.locator('[data-puz="cpu"]').click();
    const clickEvents = await page.evaluate(() => window.__r14ClickEvents);
    expect(clickEvents).toHaveLength(2);
    expect(clickEvents.map(({ target, isTrusted }) => ({ target, isTrusted }))).toEqual([
        { target: 'wifi-systemctl', isTrusted: true },
        { target: 'cpu-tab', isTrusted: true }
    ]);
    expect(clickEvents[1].timeStamp - clickEvents[0].timeStamp).toBeLessThan(450);
    await page.waitForTimeout(1100);
    const snapshot = await puzzleRuntimeSnapshot(page);
    const activeTitle = await page.evaluate(() => document.querySelector('#puzzle-title').textContent);
    expect({ activeTitle, snapshot }).toEqual({
        activeTitle: '장애 #2: 서버 #4 고CPU 경보',
        snapshot: {
            terminalLines: [
                { kind: 'command', context: null, text: 'archon@stone-igloo:~$ systemctl restart nginx' },
                { kind: 'system', context: null, text: 'Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.' },
                expect.objectContaining({ kind: 'archon', context: 'puzzle', text: expect.stringMatching(/^아콘 🐧 \/\/ .+$/) })
            ],
            tuna: '0 / 3',
            debt: '15%',
            quoteText: '아콘 독설 수집 1/62',
            quoteCount: 1,
            npc: null
        }
    });
});

test('탭 전환은 이전 탭의 NPC 조우만 새 탭에서 차단한다', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    await page.locator('[data-puz="wifi"]').click();
    await page.locator('.puzzle-option').nth(0).click();
    await page.waitForTimeout(1100);
    const stayingSnapshot = await puzzleRuntimeSnapshot(page);
    expect(stayingSnapshot.npc).toEqual({
        icon: '🐻',
        name: 'Polar Bear DevOps',
        message: 'Wi-Fi는 살아났습니다. 참치 한 캔은 제 쪽에서 처리하죠.'
    });

    await page.evaluate(() => window.__resetGameForTest());
    await page.locator('[data-puz="wifi"]').click();
    await page.locator('.puzzle-option').nth(0).click();
    await page.locator('[data-puz="cpu"]').click();
    await page.waitForTimeout(1100);

    const switchedSnapshot = await puzzleRuntimeSnapshot(page);
    const activeTitle = await page.evaluate(() => document.querySelector('#puzzle-title').textContent);
    expect({ activeTitle, npc: switchedSnapshot.npc }).toEqual({ activeTitle: '장애 #2: 서버 #4 고CPU 경보', npc: null });
    expect(switchedSnapshot.terminalLines.slice(-1)).toEqual([
        expect.objectContaining({ kind: 'archon', context: 'puzzle', text: expect.stringMatching(/^아콘 🐧 \/\/ .+$/) })
    ]);
    expect(switchedSnapshot.quoteCount).toBe(2);
});

test('퍼즐과 업그레이드는 한국어 설명과 원본 기술 토큰을 함께 제공한다', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
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
    await page.locator('[data-puz="wifi"]').click();
    const option = page.locator('.puzzle-option').first();
    await option.click();
    await expect(page.locator('#terminal-output')).toContainText('64 bytes from 8.8.8.8');
    await expect(page.locator('#npc-card')).toContainText('Polar Bear DevOps');
    await expect(page.locator('#val-tuna')).toHaveText('1 / 3');
    await option.click();
    await expect(page.locator('#terminal-output')).toContainText('에러 로그 안 읽냐? 네 눈은 장식이냐, 아니면 CSS냐?');
    await expect(page.locator('#val-tuna')).toHaveText('1 / 3');
    await expect(page.locator('#quote-collection')).toHaveText('아콘 독설 수집 2/62');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('penguin-exit-0:quote-discovery:v1')))).toMatchObject({
        version: 1,
        cursors: { puzzle: 1, repeat: 1 },
        discovered: ['puzzle:0', 'repeat:0']
    });
    await page.reload();
    await expect(page.locator('#quote-collection')).toHaveText('아콘 독설 수집 2/62');
    await page.locator('[data-puz="wifi"]').click();
    await page.locator('.puzzle-option').first().click();
    await expect(page.locator('#npc-card')).toContainText('Polar Bear DevOps');
    await page.locator('[data-puz="cpu"]').click();
    await expect.soft(page.locator('#npc-card')).toBeHidden();
    await page.locator('.puzzle-option').nth(2).click();
    await expect.soft(page.locator('#npc-card')).toBeHidden();
    await page.evaluate(() => window.__resetGameForTest());
    await page.locator('[data-puz="wifi"]').click();
    const debtOption = page.locator('.puzzle-option').nth(2);
    await debtOption.click();
    await expect(page.locator('#val-debt')).toHaveText('15%');
    await debtOption.click();
    await expect(page.locator('#val-debt')).toHaveText('15%');
    await expect(page.locator('#terminal-output [data-dialogue-context="repeat"]')).toHaveAttribute('data-dialogue-index', '1');
    await expect(page.locator('#terminal-output [data-dialogue-context="repeat"]')).toHaveAttribute('data-terminal-kind', 'archon');
    await expect(page.locator('#terminal-output [data-dialogue-context="repeat"]')).toHaveText(/^아콘 🐧 \/\/ /);
    for (const [caseName, invalidStorage] of [
        ['malformed JSON', '{'],
        ['wrong cursor type', JSON.stringify({ version: 1, cursors: 'wrong-type', discovered: [] })],
        ['out-of-range cursor', JSON.stringify({ version: 1, cursors: { puzzle: 18, repeat: 12, ai: 14, codeReview: 999 }, discovered: [] })],
        ['duplicate and unknown discovery', JSON.stringify({ version: 1, cursors: { puzzle: 0, repeat: 0, ai: 0, codeReview: 0 }, discovered: ['repeat:0', 'repeat:0', 'unknown:0'] })],
        ['wrong version', JSON.stringify({ version: 2, cursors: { puzzle: 0, repeat: 0, ai: 0, codeReview: 0 }, discovered: [] })]
    ]) {
        await page.evaluate((value) => localStorage.setItem('penguin-exit-0:quote-discovery:v1', value), invalidStorage);
        await page.reload();
        expect(await page.locator('#quote-collection').innerText(), caseName).toBe('아콘 독설 수집 0/62');
    }
    const reducedMotionTerminal = await page.evaluate(() => {
        document.querySelector('.puzzle-option:nth-child(3)').click();
        return document.getElementById('terminal-output').textContent;
    });
    expect(reducedMotionTerminal).toContain('Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.');
    expect(reducedMotionTerminal).toContain('내 할머니도 너보단 코딩을 잘하겠다.');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('penguin-exit-0:quote-discovery:v1')))).toMatchObject({
        version: 1,
        cursors: { puzzle: 1 },
        discovered: ['puzzle:0']
    });
});

test('동적 상태는 한국어 접근 이름과 엔딩 계약을 유지한다', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const initialName = await page.locator('#btn-produce').getAttribute('aria-label');
    await page.locator('#btn-produce').click();
    await expect(page.locator('#terminal-output')).toContainText('내 할머니도 너보단 코딩을 잘하겠다.');
    await expect(page.locator('#terminal-output [data-dialogue-context="codeReview"]')).toHaveAttribute('data-terminal-kind', 'archon');
    await expect(page.locator('#terminal-output [data-dialogue-context="codeReview"]')).toHaveText(/^아콘 🐧 \/\/ /);
    for (let click = 0; click < 4; click += 1) await page.locator('#btn-produce').click();
    await expect(page.locator('#terminal-output [data-dialogue-context="ai"]')).toHaveAttribute('data-terminal-kind', 'archon');
    await expect(page.locator('#terminal-output [data-dialogue-context="ai"]')).toHaveText(/^아콘 🐧 \/\/ /);
    await page.locator('#btn-revert').click();
    await page.evaluate(() => window.__resetGameForTest());
    await page.clock.install({ time: new Date('2026-08-07T00:00:00Z') });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const observed = await reachRecoverAndEnding(page, async () => {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        return page.evaluate(() => {
            document.querySelector('.puzzle-option:nth-child(3)').click();
            document.querySelector('#btn-produce').click();
            return true;
        });
    });
    const endingText = await page.locator('#ending-overlay').innerText();
    const terminalAtEnding = await page.locator('#terminal-output').textContent();
    const terminalChildCountAtEnding = await page.locator('#terminal-output > *').count();
    const terminalLastLineAtEnding = await page.locator('#terminal-output > :last-child').textContent();
    expect(terminalLastLineAtEnding).toBe('archon@stone-igloo:~$ systemctl restart nginx');
    expect(terminalChildCountAtEnding).toBeGreaterThan(0);
    await page.clock.runFor(1200);
    expect.soft(await page.locator('#terminal-output').textContent()).toBe(terminalAtEnding);
    expect.soft(await page.locator('#terminal-output > *').count()).toBe(terminalChildCountAtEnding);
    expect.soft(await page.locator('#terminal-output > :last-child').textContent()).toBe(terminalLastLineAtEnding);
    await expect.soft(page.locator('#btn-play-again')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect.soft(page.locator('#btn-play-again')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect.soft(page.locator('#btn-play-again')).toBeFocused();

    expect(initialName).toBe('코드 작성: 생산량 10과 GitHub 스타 150 획득');
    expect(observed.stages).toEqual(expectedStages);
    expect(observed.intrusions.map(({ title, body }) => ({ title, body }))).toEqual(expectedIntrusions);
    expect(observed.intrusions.map(({ produceName }) => produceName)).toEqual([
        'AI 침입 대응 중: 생산 작업 잠김', 'AI 침입 대응 중: 생산 작업 잠김', 'AI 침입 대응 중: 생산 작업 잠김', 'AI 침입 대응 중: 생산 작업 잠김'
    ]);
    expect(observed.intrusions.map(({ aiQuoteDelta }) => aiQuoteDelta)).toEqual([1, 1, 1, 1]);
    expect(observed.recoverName).toBe('RECOVER: 생산량 변화 없이 GitHub 스타 150 복구');
    expect(observed.endingName).toBe('EXIT 0 달성');
    expect(endingText).toContain('PROCESS EXIT CODE: 0');
    expect(endingText).toContain('FINANCIAL EXIT CODE: 1');
    expect(endingText).toContain('+$3,000');
    expect(endingText).toContain('-$3,001');
    expect(endingText).toContain('-$1');
    expect(endingText).toContain('샘 알트먼의 인수 제안: “우리 최신 AGI가 기름진 참치 뱃살을 원합니다.”');
    expect(endingText).toContain('신규 직함: Chief Tuna Prompt Engineer (최고 참치 프롬프트 엔지니어)');
    await expect(page.locator('#terminal-output [data-dialogue-context="ai"]')).toHaveCount(observed.intrusions.length);
});
