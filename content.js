/**
 * Penguin EXIT 0 Commercial Edition v2.1 - Content Registry (content.js)
 * Pure Data definitions for Puzzles, Upgrades, Dialogues, and AI Patterns.
 */

export const puzzles = [
    {
        id: 'wifi',
        title: '장애 #1: 사무실 Wi-Fi 연결 끊김',
        description: '북극곰 DevOps가 광섬유 케이블에 걸려 넘어졌습니다. 이글루의 Wi-Fi가 끊겼습니다.',
        encounter: { name: 'Polar Bear DevOps', icon: '🐻', message: 'Wi-Fi는 살아났습니다. 참치 한 캔은 제 쪽에서 처리하죠.' },
        choices: [
            {
                key: 'ping',
                cmd: 'ping 8.8.8.8',
                label: '1. ping 8.8.8.8 (안전한 SRE 진단)',
                isFairDiagnostic: true,
                rewardTuna: 1,
                techDebtPercent: 0,
                output: '64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=14.2 ms\n케이블이 빠져 있었습니다. 네트워크를 복구했습니다.'
            },
            {
                key: 'top',
                cmd: 'top / ip link',
                label: '2. top / ip link (근본 원인 분석)',
                isFairDiagnostic: true,
                rewardTuna: 2,
                techDebtPercent: 0,
                output: 'eth0: state DOWN\n링크 상태와 라우팅을 함께 확인했습니다. 범인은 케이블입니다.'
            },
            {
                key: 'systemctl',
                cmd: 'systemctl restart nginx',
                label: '3. systemctl restart nginx (무작정 재시작)',
                isFairDiagnostic: false,
                rewardTuna: 0,
                techDebtPercent: 15,
                output: 'Nginx를 재시작했지만 인터넷은 여전히 죽어 있습니다.'
            }
        ]
    },
    {
        id: 'cpu',
        title: '장애 #2: 서버 #4 고CPU 경보',
        description: '바다코끼리 DBA가 프로덕션에서 암호화폐 채굴기를 돌렸습니다. CPU가 100%입니다.',
        encounter: { name: 'Walrus DBA', icon: '🐘', message: '그건 백그라운드 작업이었다고 우기려 했는데… 들켰군요.' },
        choices: [
            {
                key: 'ip_link',
                cmd: 'ip link show / top',
                label: '1. top / ip link show (PID 1337 점검)',
                isFairDiagnostic: true,
                rewardTuna: 1,
                techDebtPercent: 0,
                output: 'PID 1337 xmrig가 CPU 99.9%를 점유 중입니다. 프로세스와 네트워크를 확인했습니다.'
            },
            {
                key: 'kill',
                cmd: 'kill -9 1337',
                label: '2. kill -9 1337 (마이너 종료)',
                isFairDiagnostic: true,
                rewardTuna: 2,
                techDebtPercent: 0,
                output: '[1] + Killed xmrig\nCPU 사용량이 2%로 떨어졌습니다. 프로덕션을 살렸습니다.'
            },
            {
                key: 'reboot',
                cmd: 'reboot',
                label: '3. reboot (피크 시간 재부팅)',
                isFairDiagnostic: false,
                rewardTuna: 0,
                techDebtPercent: 20,
                output: '피크 시간에 DB를 재부팅했습니다. CEO가 전화 중입니다.'
            }
        ]
    },
    {
        id: 'ssh',
        title: '장애 #3: 골든 티켓 SSH 침입',
        description: '캘리포니아의 미확인 IP 블록에서 SSH 연결 요청이 들어왔습니다. 로그부터 확인하십시오.',
        encounter: { name: 'Sam Altman', icon: '🤖', message: 'I like your penguin hustle. 다음 open-source 프로젝트는 제가 투자하죠.' },
        choices: [
            {
                key: 'auth_log',
                cmd: 'cat /var/log/auth.log',
                label: '1. cat /var/log/auth.log (로그 감사)',
                isFairDiagnostic: true,
                rewardTuna: 1,
                techDebtPercent: 0,
                output: 'Accepted publickey for sam_altman from 192.168.x.x\n로그에 낯익은 이름이 있습니다.'
            },
            {
                key: 'altman',
                cmd: 'ssh-copy-id sam_altman',
                label: '2. ssh-copy-id sam_altman (탐욕스러운 동맹)',
                isFairDiagnostic: false,
                rewardTuna: 2,
                techDebtPercent: 25,
                output: 'Key installed. OpenAI로 향하는 보안 터널을 연결했습니다.',
                resultPresentation: {
                    type: 'dangerousAlliance',
                    title: '⚠ 위험한 동맹이 체결되었습니다',
                    summary: '참치 +2 · 기술 부채 +25%',
                    description: 'SSH 키를 넘긴 대가로 빠른 보상을 얻었지만, 시스템은 수상한 동맹을 기억합니다.',
                    imageSrc: 'assets/dangerous-alliance-ssh.png',
                    imageAlt: '붉은 SSH 터널 앞에서 수상한 동맹을 맺는 두 인물의 악수'
                }
            }
        ]
    }
];

export const upgrades = [
    {
        id: 'coffee',
        name: '[ESP] 북극곰 에스프레소 머신',
        costStars: 300,
        bonus: 3,
        description: '작업당 생산량이 +3 유닛 증가합니다.'
    },
    {
        id: 'server_rack',
        name: '[HPC] 바다코끼리 고성능 클러스터',
        costStars: 600,
        bonus: 5,
        description: '작업당 생산량이 +5 유닛 증가합니다.'
    }
];

export const dialogueDecks = {
    puzzle: [
        'tcpdump는 패킷을 잡는데 넌 멱살을 잡고 싶게 만드는구나. SYN만 보내고 ACK는 언제 줄래?', '지식은 레버리지가 아니다 애송아.', '로그나 쳐 읽어라.', '서버 터지면 네 목통도 터진다.', 'p99 latency 먼저 확인하고 쳐라.', '지우지 마라. 네가 싼 똥(에러)을 똑바로 직시해라 ₩_₩', '이글루에서 당장 짐 싸서 나가라.', '네 뇌가 가비지 컬렉션(GC) 당한 거 아니냐?',
        '명령어를 고른 근거가 뭐냐? 네 손가락이 네 뇌보다 먼저 취업했냐?', '그건 해결책이 아니라 장애 보고서 첫 문장이다.', '재시작은 진단이 아니다. 생각을 껐다 켜는 건 네 머리로 충분하다.', '로그 세 줄 읽는 게 그렇게 힘드냐? 네 커리어는 한 줄로 끝나겠다.', '프로덕션에 기도문을 배포하지 마라. 로그는 읽고 울어라.', '지금 누른 건 버튼이 아니라 야근 확정 도장이다.', '원인 분석을 302로 리다이렉트했냐? 목적지가 왜 ‘감’이야?', '문제는 Wi-Fi가 아니라 네 사고 회로가 비행기 모드인 거다.', 'PID는 찾았는데 범인은 못 찾았네. 거울을 안 봤구나.', 'SSH 키를 뿌릴 거면 명함도 같이 뿌려라. 공격자가 연락하기 편하게.',
        '너랑 대화하는 건 split-brain 걸린 etcd 클러스터랑 합의(Raft Consensus) 보는 것보다 힘들다.', 'CAP 정리 몰라? 일관성도 없고 가용성도 없는데 넌 도대체 무슨 파티션을 격리한 거냐?', '2단계 커밋(2PC) 중에 코디네이터가 도망친 기분이다. 네 트랜잭션은 평생 롤백 불가다.', '서비스 메시(Service Mesh)를 깔았더니 레이턴시가 아니라 네 핑계만 라우팅되는구나.', 'TLS Handshake에서 암호화 스위트가 불일치하는 것처럼 네 코드와 현실이 따로 놀고 있다.', '비잔틴 장군 문제(Byzantine Generals Problem)를 여기서 보네. 네 함수가 거짓말을 하고 있다.', '서킷 브레이커(Circuit Breaker)가 오픈됐는데 트래픽을 왜 계속 들이붓냐? 불난 집에 부채질하냐?', '로드 밸런서(Load Balancer) 가중치 설정을 1:0으로 줬냐? 한 놈만 패네.', 'DNS TTL을 86400초로 걸어놓고 IP를 바꿨어? 넌 내일까지 반성문이나 써라.', 'BGP 하이재킹 당한 라우터처럼 네 멘탈이 이상한 목적지로 표류 중이다.'
    ],
    repeat: [
        '에러 로그 안 읽냐? 네 눈은 장식이냐, 아니면 CSS냐?', '방금 네가 무지성으로 누른 그 엔터 한 번이 500달러짜리 장애다.', '지수 백오프(Exponential Backoff)라는 말 못 배웠냐? 네 연타는 재시도가 아니라 자폭이다.', '원숭이한테 키보드 주고 바나나 주면서 치게 해도 너보단 에러 덜 낸다.', '침착해라. 마우스 부순다고 메모리 누수가 고쳐지진 않는다.', '버튼을 그 속도로 갈기면 OOM Killer가 네 세션부터 죽이러 올 거다. 커널도 인내심의 한계가 있다.', '한 번 더 아무 생각 없이 누르면 네 SSH 접속 키를 날려버리겠다.',
        '또 눌렀네. 멱등성 테스트가 아니라 내 인내심 DDoS다.', '클릭 횟수로 실력이 늘었으면 네 마우스가 CTO였겠다.', '버튼을 세 번 누르면 근본 원인이 부끄러워서 자수할 줄 알았냐?', '연타하지 마라. 장애는 리듬게임이 아니다.', '네 손가락은 hot path인데 사고 과정은 아직 cold start다.'
    ],
    ai: [
        'AI가 짜준 코드 복붙하다가 서버 터지면 AI가 책임지냐? 네 목통이 터지는 거다.', '챗GPT한테 네 연봉도 대신 받아달라고 하지 그러냐?', 'Copilot이 짠 코드를 리뷰도 없이 푸시(Push)해? 넌 내일부터 Copilot의 키보드 받침대다.', 'AI 개싸움판에 낀 걸 환영한다. 근데 네가 제일 약해 보인다.', 'AGI가 오기 전에 너부터 대체되겠다. 아니, 이미 스크립트 5줄로 대체 가능할지도.', '오픈AI가 널 보면 인공지능이 아니라 인공지능 미만의 무언가로 분류할 거다.',
        'Copilot이 핸들을 잡았는데 넌 왜 조수석에서 코드 리뷰를 자고 있냐?', 'Codex가 finalFinalV7을 만들었다고? 네가 finalFinalV6까지 허락한 게 더 큰 죄다.', 'Gemini가 3초 생각하는 동안 넌 3년치 기술 부채를 만들었다.', 'AI 셋이 싸우는데 인간인 네 코드가 제일 먼저 탈락했다.', '프롬프트는 2천 자인데 요구사항은 실종됐다. 네 회의록도 이 모양이냐?', 'AI 출력에 초록 체크가 떴다고 진실이 된 줄 아냐? 신호등도 고장 난다.', '모델을 바꾸기 전에 질문부터 사람 말로 바꿔라.', '컨텍스트는 100만 토큰인데 네 핵심은 아직 로딩 중이다.',
        '프롬프트에 \'절대 실수하지 마\'라고 적으면 모델이 감동해서 버그를 지워줄 줄 알았냐?', 'Temperature를 0.0으로 줘도 네 코드의 환각(Hallucination)은 2.0 수준이네.', 'KV Cache가 넘쳐나는데 정작 네 머릿속 캐시는 콜드 미스(Cold Miss)의 연속이구나.', 'Attention Weight를 아무리 시각화해 봐도 네가 어디서 삽질을 시작했는지는 모델도 모른다더라.', 'LoRA로 파인튜닝할 게 아니라 네 기초 자료구조 지식부터 제로베이스에서 사전학습시켜야겠다.', 'RLHF를 거치긴커녕 인간 피드백(Human Feedback)을 거부하는 네 고집이 더 문제다.', '임베딩 벡터 거리가 코사인 유사도 -1.0이다. 요구사항과 정반대로 달리고 있단 뜻이다.', 'Top-P를 0.01로 좁혀도 네 오답 확률은 여전히 100%에 수렴한다.', 'RAG(검색 증강 생성)를 구축했더니 쓸데없는 위키 문서만 퍼오네. 네 검색 습관이랑 똑같다.', '양자화(Quantization)를 int2로 압축한 것처럼 네 답변엔 내용이 하나도 없다.'
    ],
    codeReview: [
        '내 할머니도 너보단 코딩을 잘하겠다.', '이딴 걸 코드라고 짰냐? 스파게티도 이거보단 논리적으로 꼬여있겠다.', '네 코드는 마치 윈도우 ME 같다. 존재 자체가 블루스크린이다.', '이딴 식으로 짤 거면 그냥 엑셀로 짜라. 그게 낫겠다.', '변수명이 data1, data2? 네 이름도 human1로 바꿔줄까?', '예외 처리(Exception Handling)를 try-catch로 다 삼켜버리네? 블랙홀이냐?', '네가 짠 코드를 보면 Linus Torvalds가 무덤에서 일어날 거다. (아직 안 죽었지만 널 패려고)', 'p99 latency 10ms 넘어가면 밥 굶을 준비 해라.', '롤백(Rollback) 플랜 없이 배포 버튼 누르는 놈은 내 팀에 필요 없다.', '모르면 추측하지 말고 strace를 걸어라. 추측은 버그의 어머니다.', '카나리 1% 배포 안 하고 프로덕션 직행? 네 인생도 카나리 없이 훅 갈 수 있다.',
        '네 코드에 타입은 없고 희망사항만 있다.', '이 커밋은 revert가 아니라 제사부터 지내야 한다.', 'null 체크를 안 했네. 네 커리어도 곧 undefined다.', 'O(N²)을 사랑하냐? CPU 팬이 네 러브레터에 답장 중이다.', '변수명 `tmp2_final_real`? 유언장도 버전 관리로 쓰냐?', '테스트가 초록색인 이유는 아무것도 검증하지 않아서다. 잔디밭이냐?', '네 PR은 리뷰가 아니라 목격자 진술이 필요하다.',
        'strace 한 번 안 걸어보고 시스템 콜을 논하네. 장님 코끼리 다리 만지는 것도 이것보단 과학적이겠다.', 'cgroups v2로 네 키보드 타건 대역폭부터 1Bps로 스로틀링 걸고 싶다.', '페이지 폴트(Page Fault)가 초당 만 번 터지는데 넌 화면만 멍하니 보고 있냐? 디스크가 울고 있다.', 'Dirty Cow 취약점보다 위험한 게 방금 네가 친 sudo rm -rf 오타다.', 'perf top 찍어봤더니 병목 1위가 네 망설임으로 나오더라.', 'L1 D-Cache 미스율이 90%다. 캐시 라인을 그렇게 패대기치기도 쉽지 않겠다.', 'Context Switching이 초당 50만 번 발생 중이다. CPU가 멀미하고 있다.', '하드웨어 브랜치 예측기(Branch Predictor)도 네 다음 실수는 예측 못 하겠단다.', '커널 패닉(Kernel Panic)이 났는데 모니터를 닦고 있냐? dmesg나 열어봐라.', 'epoll_wait에서 블로킹 걸린 것처럼 네 대답은 왜 이렇게 늘어지냐?',
        'Layout Thrashing을 루프 안에서 돌리네? 브라우저 메인 스레드가 네 코드를 보고 파업했다.', 'CSS 하나 바꾸는데 리플로우(Reflow)가 전역으로 터지네. 돔 트리(DOM Tree)가 도끼를 맞았다.', '메모리 릭(Memory Leak)으로 힙(Heap)이 2GB를 넘겼는데 넌 브라우저 탭을 탓하냐?', '웹소켓(WebSocket) 열어놓고 하트비트(Heartbeat)도 안 보내네. 침묵은 금이 아니라 연결 종료(1006)다.', 'WebAssembly를 쓰면 뭐하냐, 그걸 호출하는 네 로직이 O(N³)인데.', 'Microtask Queue에 무한 프로미스를 밀어 넣네. 이벤트 루프가 질식사했다.', 'Service Worker 캐시를 안 비워서 3달 전 버그가 아직도 라이브 서빙 중이네.', 'IndexedDB 트랜잭션 열어놓고 닫지도 않았네. 브라우저 저장소가 잠겨버렸다.'
    ]
};
