import { STAR_TARGET, createInitialState, reduceGameState } from './game-core.js';
import { dialogueDecks, puzzles, upgrades } from './content.js';

let state = createInitialState();
let activePuzzleId = 'wifi';
let endingRendered = false;
let geminiTimerId = null;
let intrusionImpactType = null;
let latestPuzzleResultId = 0;
let pendingPuzzleResultSlot = null;
let dangerousAllianceTrigger = null;
const reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
const quoteStorageKey = 'penguin-exit-0:quote-discovery:v2';
const dialogueContexts = Object.keys(dialogueDecks);
const totalDialogueCount = Object.values(dialogueDecks)
    .reduce((total, deck) => total + deck.length, 0);
const resolvedChoices = new Set();
const resolvedPuzzleEconomies = new Set();
const pendingTerminalTimers = new Set();
let quoteDiscovery = loadQuoteDiscovery();

// Test exposure for zero-allocation state reset
window.__resetGameForTest = function() {
    clearIntrusionImpact();
    state = createInitialState();
    endingRendered = false;
    resolvedChoices.clear();
    resolvedPuzzleEconomies.clear();
    latestPuzzleResultId += 1;
    pendingPuzzleResultSlot = null;
    clearTerminalTimers();
    closeDangerousAlliance({ restoreFocus: false });
    terminalOutput.replaceChildren();
    npcCard.hidden = true;
    clearGeminiTimer();
    const endingOverlay = document.getElementById('ending-overlay');
    if (endingOverlay) endingOverlay.style.display = 'none';
    renderGameState();
};

// UI Elements
const valUnits = document.getElementById('val-units');
const valStars = document.getElementById('val-stars');
const valDebt = document.getElementById('val-debt');
const valThreat = document.getElementById('val-threat');
const valTuna = document.getElementById('val-tuna');
const valCost = document.getElementById('val-cost');

const intrusionBanner = document.getElementById('intrusion-banner');
const intrusionTitle = document.getElementById('intrusion-title');
const intrusionMsg = document.getElementById('intrusion-msg');
const btnRevert = document.getElementById('btn-revert');
const btnCeoShip = document.getElementById('btn-ceo-ship');
const btnAcceptPenalty = document.getElementById('btn-accept-penalty');

const stageBadge = document.getElementById('stage-badge');
const shelterDisplay = document.getElementById('shelter-stage-display');
const btnProduce = document.getElementById('btn-produce');
const upgradeList = document.getElementById('upgrade-list');

const puzzleTitle = document.getElementById('puzzle-title');
const puzzleDescription = document.getElementById('puzzle-description');
const puzzleOptions = document.getElementById('puzzle-options');
const puzzlePanel = document.getElementById('puzzle-panel');
const tabBtns = document.querySelectorAll('.tab-btn');
const terminalOutput = document.getElementById('terminal-output');
const npcCard = document.getElementById('npc-card');
const npcIcon = document.getElementById('npc-icon');
const npcName = document.getElementById('npc-name');
const npcMessage = document.getElementById('npc-message');
const quoteCollection = document.getElementById('quote-collection');

const dangerousAllianceOverlay = document.getElementById('dangerous-alliance-overlay');
const dangerousAllianceHeading = document.getElementById('dangerous-alliance-heading');
const dangerousAllianceImage = document.getElementById('dangerous-alliance-image');
const dangerousAllianceSummary = document.getElementById('dangerous-alliance-summary');
const dangerousAllianceDescription = document.getElementById('dangerous-alliance-description');
const btnAcceptAllianceResult = document.getElementById('btn-accept-alliance-result');

const endingOverlay = document.getElementById('ending-overlay');
const endingIncidentCost = document.getElementById('ending-incident-cost');
const btnPlayAgain = document.getElementById('btn-play-again');
const endingBackground = [
    document.querySelector('header'),
    document.querySelector('.dashboard'),
    intrusionBanner,
    document.querySelector('.main-grid')
];

function loadQuoteDiscovery() {
    const empty = { version: 2, cursors: Object.fromEntries(dialogueContexts.map((context) => [context, 0])), discovered: new Set() };
    try {
        const saved = JSON.parse(localStorage.getItem(quoteStorageKey));
        if (!saved || saved.version !== 2 || !saved.cursors || !Array.isArray(saved.discovered)) return empty;
        for (const context of dialogueContexts) {
            const cursor = saved.cursors[context];
            if (!Number.isInteger(cursor) || cursor < 0 || cursor >= dialogueDecks[context].length) return empty;
            empty.cursors[context] = cursor;
        }
        const discovered = new Set();
        for (const slot of saved.discovered) {
            const match = /^(puzzle|repeat|ai|codeReview):(\d+)$/.exec(slot);
            if (!match || Number(match[2]) >= dialogueDecks[match[1]].length || discovered.has(slot)) return empty;
            discovered.add(slot);
        }
        empty.discovered = discovered;
    } catch {
        return empty;
    }
    return empty;
}

function saveQuoteDiscovery() {
    try {
        localStorage.setItem(quoteStorageKey, JSON.stringify({
            version: 2,
            cursors: quoteDiscovery.cursors,
            discovered: [...quoteDiscovery.discovered].sort()
        }));
    } catch {
        // A full or unavailable localStorage must not interrupt the game.
    }
}

function prefersReducedMotion() {
    return reducedMotionQuery?.matches === true;
}

function clearIntrusionImpact() {
    document.body.classList.remove('intrusion-impact--copilot', 'intrusion-impact--codex', 'intrusion-impact--gemini', 'intrusion-impact--ceo');
    intrusionImpactType = null;
}

function startIntrusionImpact(type) {
    clearIntrusionImpact();
    if (prefersReducedMotion()) return;
    document.body.classList.add(`intrusion-impact--${type}`);
    intrusionImpactType = type;
}

if (reducedMotionQuery) {
    reducedMotionQuery.addEventListener('change', (event) => {
        if (event.matches) clearIntrusionImpact();
    });
}

function appendTerminalLine(text, context = '', index = null, kind = '') {
    const line = document.createElement('div');
    line.className = 'terminal-line';
    if (context) line.dataset.dialogueContext = context;
    if (index !== null) line.dataset.dialogueIndex = String(index);
    if (kind) line.dataset.terminalKind = kind;
    line.textContent = text;
    terminalOutput.appendChild(line);
    while (terminalOutput.childElementCount > 80) terminalOutput.firstElementChild.remove();
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function setEndingModalActive(active) {
    endingBackground.forEach((element) => {
        element.inert = active;
    });
}

function clearTerminalTimers() {
    for (const timerId of pendingTerminalTimers) clearTimeout(timerId);
    pendingTerminalTimers.clear();
}

function scheduleTerminal(callback, delay) {
    if (prefersReducedMotion()) {
        callback();
        return;
    }
    const timerId = setTimeout(() => {
        pendingTerminalTimers.delete(timerId);
        callback();
    }, delay);
    pendingTerminalTimers.add(timerId);
}

function renderQuoteCollection() {
    quoteCollection.textContent = `아콘 독설 수집 ${quoteDiscovery.discovered.size}/${totalDialogueCount}`;
}

function appendDialogue(context) {
    const deck = dialogueDecks[context];
    const index = quoteDiscovery.cursors[context];
    quoteDiscovery.cursors[context] = (index + 1) % deck.length;
    quoteDiscovery.discovered.add(`${context}:${index}`);
    saveQuoteDiscovery();
    renderQuoteCollection();
    appendTerminalLine(`아콘 🐧 // ${deck[index]}`, context, index, 'archon');
}

function showEncounter(encounter) {
    closeDangerousAlliance({ restoreFocus: false });
    npcIcon.textContent = encounter.icon;
    npcName.textContent = encounter.name;
    npcMessage.textContent = encounter.message;
    npcCard.hidden = false;
}

function openDangerousAlliance(resultPresentation, triggerButton) {
    npcCard.hidden = true;
    dangerousAllianceHeading.textContent = resultPresentation.title;
    dangerousAllianceImage.setAttribute('src', resultPresentation.imageSrc);
    dangerousAllianceImage.setAttribute('alt', resultPresentation.imageAlt);
    dangerousAllianceSummary.textContent = resultPresentation.summary;
    dangerousAllianceDescription.textContent = resultPresentation.description;
    btnAcceptAllianceResult.textContent = '대가를 감수한다';
    dangerousAllianceTrigger = triggerButton;
    setEndingModalActive(true);
    dangerousAllianceOverlay.hidden = false;
    btnAcceptAllianceResult.focus();
}

function closeDangerousAlliance({ restoreFocus = true } = {}) {
    const focusTarget = dangerousAllianceTrigger;
    dangerousAllianceOverlay.hidden = true;
    setEndingModalActive(false);
    dangerousAllianceTrigger = null;
    if (restoreFocus && focusTarget?.isConnected && !focusTarget.disabled) focusTarget.focus();
}

function queuePuzzleResult(puzzle, choice, repeated, triggerButton) {
    appendTerminalLine(`archon@stone-igloo:~$ ${choice.cmd}`, '', null, 'command');
    scheduleTerminal(() => appendTerminalLine(choice.output, '', null, 'system'), 450);
    const scheduledPuzzleId = puzzle.id;
    const resultSlot = `${puzzle.id}:${choice.key}`;
    const preservesPendingResult = repeated && pendingPuzzleResultSlot === resultSlot;
    const scheduledResultId = preservesPendingResult
        ? latestPuzzleResultId
        : ++latestPuzzleResultId;
    if (!repeated) pendingPuzzleResultSlot = resultSlot;
    else if (!preservesPendingResult) pendingPuzzleResultSlot = null;
    scheduleTerminal(() => {
        if (repeated) {
            if (!choice.isFairDiagnostic) appendDialogue('repeat');
        }
        else {
            if (!choice.isFairDiagnostic) appendDialogue('puzzle');
            if (activePuzzleId !== scheduledPuzzleId || scheduledResultId !== latestPuzzleResultId) return;
            pendingPuzzleResultSlot = null;
            if (choice.resultPresentation) openDangerousAlliance(choice.resultPresentation, triggerButton);
            else if (choice.isFairDiagnostic) showEncounter(puzzle.encounter);
        }
    }, 1050);
}

// Keydown handler for Escape key (git revert)
window.addEventListener('keydown', (e) => {
    if (!dangerousAllianceOverlay.hidden && (e.key === 'Escape' || e.key === 'Tab')) {
        e.preventDefault();
        if (e.key === 'Escape') closeDangerousAlliance();
        else btnAcceptAllianceResult.focus();
        return;
    }
    if (endingRendered && endingOverlay.style.display !== 'none' && e.key === 'Tab') {
        e.preventDefault();
        btnPlayAgain.focus();
        return;
    }
    if (e.key === 'Escape' && state.activeIntrusion !== null) {
        clearIntrusionImpact();
        clearGeminiTimer();
        if (state.activeIntrusion === 'ceo') {
            state = reduceGameState(state, { type: 'REJECT_CEO_ORDER' });
        } else {
            state = reduceGameState(state, { type: 'RESOLVE_INTRUSION' });
        }
        renderGameState();
        btnProduce.focus();
    }
});

btnAcceptAllianceResult.addEventListener('click', () => closeDangerousAlliance());

function clearGeminiTimer() {
    if (geminiTimerId !== null) {
        clearTimeout(geminiTimerId);
        geminiTimerId = null;
    }
}

function syncGeminiTimer() {
    if (state.activeIntrusion === 'gemini') {
        if (geminiTimerId === null) {
            geminiTimerId = setTimeout(() => {
                geminiTimerId = null;
                if (state.activeIntrusion === 'gemini') {
                    clearIntrusionImpact();
                    state = reduceGameState(state, { type: 'RESOLVE_INTRUSION' });
                    renderGameState();
                    btnProduce.focus();
                }
            }, 3000);
        }
    } else {
        clearGeminiTimer();
    }
}

// Intrusion Resolution Actions
btnRevert.addEventListener('click', () => {
    clearIntrusionImpact();
    clearGeminiTimer();
    if (state.activeIntrusion === 'ceo') {
        state = reduceGameState(state, { type: 'REJECT_CEO_ORDER' });
    } else {
        state = reduceGameState(state, { type: 'RESOLVE_INTRUSION' });
    }
    renderGameState();
    btnProduce.focus();
});

btnCeoShip.addEventListener('click', () => {
    clearIntrusionImpact();
    clearGeminiTimer();
    state = reduceGameState(state, { type: 'RESOLVE_CEO_SHIP' });
    renderGameState();
    btnProduce.focus();
});

btnAcceptPenalty.addEventListener('click', () => {
    clearIntrusionImpact();
    clearGeminiTimer();
    state = reduceGameState(state, { type: 'APPLY_AI_PENALTY' });
    renderGameState();
    btnProduce.focus();
});

// Produce & Recover Main Action Handler
btnProduce.addEventListener('click', () => {
    const wasActiveIntrusion = state.activeIntrusion;
    if (state.productionUnits >= 200 && state.githubStars < STAR_TARGET) {
        state = reduceGameState(state, { type: 'RECOVER' });
    } else {
        state = reduceGameState(state, { type: 'PRODUCE' });
        appendDialogue('codeReview');
    }
    if (wasActiveIntrusion === null && state.activeIntrusion !== null) appendDialogue('ai');
    renderGameState();
    if (wasActiveIntrusion === null && state.activeIntrusion !== null) startIntrusionImpact(state.activeIntrusion);
});

function selectPuzzleTab(btn, moveFocus = false) {
    const nextPuzzleId = btn.getAttribute('data-puz');
    if (nextPuzzleId !== activePuzzleId) {
        latestPuzzleResultId += 1;
        pendingPuzzleResultSlot = null;
        npcCard.hidden = true;
        activePuzzleId = nextPuzzleId;
        renderPuzzles();
    }
    tabBtns.forEach(b => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-selected', String(isActive));
        b.tabIndex = isActive ? 0 : -1;
    });
    puzzlePanel.setAttribute('aria-labelledby', btn.id);
    if (moveFocus) btn.focus();
}

// Tab Handlers
tabBtns.forEach((btn, index) => {
    btn.addEventListener('click', () => selectPuzzleTab(btn));
    btn.addEventListener('keydown', (event) => {
        let nextIndex;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabBtns.length;
        else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabBtns.length) % tabBtns.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = tabBtns.length - 1;
        else return;
        event.preventDefault();
        selectPuzzleTab(tabBtns[nextIndex], true);
    });
});

function renderPuzzles() {
    puzzleOptions.innerHTML = '';
    const currentPuzzle = puzzles.find(p => p.id === activePuzzleId) || puzzles[0];
    puzzleTitle.textContent = currentPuzzle.title;
    puzzleDescription.textContent = currentPuzzle.description;

    currentPuzzle.choices.forEach((choice) => {
        const btn = document.createElement('button');
        btn.className = 'puzzle-option';
        btn.textContent = choice.label;
        btn.setAttribute('aria-label', choice.label);

        btn.addEventListener('click', () => {
            clearIntrusionImpact();
            npcCard.hidden = true;
            const choiceSlot = `${currentPuzzle.id}:${choice.key}`;
            const repeated = resolvedChoices.has(choiceSlot);
            if (!repeated) resolvedChoices.add(choiceSlot);
            if (!resolvedPuzzleEconomies.has(currentPuzzle.id)) {
                resolvedPuzzleEconomies.add(currentPuzzle.id);
                if (choice.rewardTuna > 0) {
                    state = reduceGameState(state, { type: 'ADD_TUNA', amount: choice.rewardTuna });
                }
                if (choice.techDebtPercent > 0) {
                    state = reduceGameState(state, { type: 'ADD_TECH_DEBT', percent: choice.techDebtPercent });
                }
            }
            queuePuzzleResult(currentPuzzle, choice, repeated, btn);
            renderGameState();
        });

        puzzleOptions.appendChild(btn);
    });
}

function renderUpgrades() {
    upgradeList.innerHTML = '';
    upgrades.forEach(up => {
        const isOwned = state.activeUpgrades.some(u => u.id === up.id);
        const card = document.createElement('div');
        card.className = 'upgrade-card';
        const copy = document.createElement('div');
        copy.className = 'upgrade-copy';
        const name = document.createElement('div');
        name.className = 'upgrade-name';
        name.style.fontWeight = '600';
        name.style.fontSize = '0.9rem';
        name.textContent = up.name;
        const description = document.createElement('div');
        description.className = 'upgrade-description';
        description.style.fontSize = '0.75rem';
        description.style.color = '#94a3b8';
        description.textContent = up.description;
        copy.append(name, description);
        const buyBtn = document.createElement('button');
        buyBtn.className = 'btn-touch';
        buyBtn.disabled = isOwned || state.githubStars < up.costStars;
        buyBtn.textContent = isOwned ? '보유 중' : `구매 (${up.costStars}★)`;
        card.append(copy, buyBtn);
        if (!isOwned) {
            buyBtn.addEventListener('click', () => {
                state = reduceGameState(state, { type: 'BUY_UPGRADE', upgradeId: up.id });
                renderGameState();
            });
        }
        upgradeList.appendChild(card);
    });
}

function renderGameState() {
    // 1. Metrics
    valUnits.textContent = `${state.productionUnits} / 200`;
    valStars.textContent = `${state.githubStars} ★`;
    valDebt.textContent = `${state.techDebt}%`;
    valThreat.textContent = `${state.threatMeter} / 100`;
    valTuna.textContent = `${state.tunaCans} / 3`;
    valCost.textContent = `-$${state.incidentCost}`;

    // 2. Intrusion Banner State & 4 AI Model Customization
    if (state.activeIntrusion !== null) {
        intrusionBanner.style.display = 'block';
        btnProduce.disabled = true;
        btnProduce.textContent = 'AI 침입 진행 중 — Esc로 롤백';
        btnProduce.setAttribute('aria-label', 'AI 침입 대응 중: 생산 작업 잠김');
        btnProduce.classList.remove('is-produce', 'is-recover', 'is-complete');
        btnProduce.classList.add('is-locked');

        if (state.activeIntrusion === 'copilot') {
            intrusionTitle.textContent = '🤖 Copilot 코드 침입!';
            intrusionMsg.textContent = 'Copilot이 반복되는 나쁜 코드를 생성했습니다! Esc 또는 git revert로 되돌리세요.';
            btnRevert.textContent = 'git revert (Esc)';
            btnCeoShip.style.display = 'none';
        } else if (state.activeIntrusion === 'codex') {
            intrusionTitle.textContent = '🧠 Codex 타입 침입!';
            intrusionMsg.textContent = 'Codex가 변수명을 finalFinalV7로 바꿨습니다! unsafe_cast를 수정하세요.';
            btnRevert.textContent = 'Fix unsafe_cast (Esc)';
            btnCeoShip.style.display = 'none';
        } else if (state.activeIntrusion === 'gemini') {
            intrusionTitle.textContent = '✨ Gemini 응답 지연!';
            intrusionMsg.textContent = 'Gemini가 응답을 생성 중입니다... 3초 후 자동 해제되며 Esc로도 해제할 수 있습니다.';
            btnRevert.textContent = 'Dismiss (Esc)';
            btnCeoShip.style.display = 'none';
        } else if (state.activeIntrusion === 'ceo') {
            intrusionTitle.textContent = '💼 CEO 금요일 17:59 배포 지시!';
            intrusionMsg.textContent = 'CEO가 즉시 프로덕션 배포를 요구합니다!';
            btnRevert.textContent = 'Reject (-500★)';
            btnCeoShip.style.display = 'inline-block';
        }
    } else {
        intrusionBanner.style.display = 'none';

        // 3. Produce vs Recover Button State Logic
        if (state.productionUnits >= 200 && state.githubStars < STAR_TARGET) {
            btnProduce.disabled = false;
            btnProduce.textContent = '🔄 RECOVER (야근 복구 +150★)';
            btnProduce.setAttribute('aria-label', 'RECOVER: 생산량 변화 없이 GitHub 스타 150 복구');
            btnProduce.classList.remove('is-produce', 'is-complete', 'is-locked');
            btnProduce.classList.add('is-recover');
        } else if (state.productionUnits >= 200 && state.githubStars >= STAR_TARGET) {
            btnProduce.disabled = true;
            btnProduce.textContent = '🎉 EXIT 0 달성!';
            btnProduce.setAttribute('aria-label', 'EXIT 0 달성');
            btnProduce.classList.remove('is-produce', 'is-recover', 'is-locked');
            btnProduce.classList.add('is-complete');
        } else {
            btnProduce.disabled = false;
            btnProduce.textContent = '💻 코드 작성 (+10 유닛 / +150★)';
            btnProduce.setAttribute('aria-label', '코드 작성: 생산량 10과 GitHub 스타 150 획득');
            btnProduce.classList.remove('is-recover', 'is-complete', 'is-locked');
            btnProduce.classList.add('is-produce');
        }
    }

    // 4. Visual Stage Boundaries (0, 40, 80, 120, 160, 200)
    if (state.productionUnits >= 200 && state.githubStars >= STAR_TARGET) {
        stageBadge.textContent = '5단계 · 마이애미 해변의 AGI 재벌 · EXIT 0';
        shelterDisplay.textContent = '🐧🏖️🍹';
    } else if (state.productionUnits >= 200) {
        stageBadge.textContent = '5단계 · 복구 중';
        shelterDisplay.textContent = '🐧🏖️🍹';
    } else if (state.productionUnits >= 160) {
        stageBadge.textContent = '4단계 · 초거대 AI 데이터센터 CEO';
        shelterDisplay.textContent = '🐧👔🏢';
    } else if (state.productionUnits >= 120) {
        stageBadge.textContent = '3단계 · 남극 펭귄 연구소';
        shelterDisplay.textContent = '🐧🥼🖥️';
    } else if (state.productionUnits >= 80) {
        stageBadge.textContent = '2.5단계 · 하이테크 이글루 스타트업';
        shelterDisplay.textContent = '🐧⛺⚡';
    } else if (state.productionUnits >= 40) {
        stageBadge.textContent = '2단계 · 이글루 차고 스타트업';
        shelterDisplay.textContent = '🐧⛺💻';
    } else {
        stageBadge.textContent = '1단계 · 혹한 속 택배 상자';
        shelterDisplay.textContent = '🐧📦';
    }

    // 5. Render Sub-components & Gemini Timer Sync
    renderUpgrades();
    syncGeminiTimer();

    // 6. Ending Check (One-shot modal rendering, no alert spam!)
    if (state.endingTriggered && !endingRendered) {
        clearIntrusionImpact();
        closeDangerousAlliance({ restoreFocus: false });
        endingRendered = true;
        clearGeminiTimer();
        clearTerminalTimers();
        setEndingModalActive(true);
        endingIncidentCost.textContent = `장애 비용 -$${state.incidentCost}`;
        endingOverlay.style.display = 'flex';
        btnPlayAgain.focus();
    }
}

intrusionBanner.addEventListener('animationend', (event) => {
    if (event.target === intrusionBanner && event.animationName === `intrusion-impact-${intrusionImpactType}`) clearIntrusionImpact();
});

intrusionBanner.addEventListener('animationcancel', (event) => {
    if (event.target === intrusionBanner && event.animationName === `intrusion-impact-${intrusionImpactType}`) clearIntrusionImpact();
});

// Initial Render
renderQuoteCollection();
renderPuzzles();
renderGameState();
