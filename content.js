/**
 * Penguin EXIT 0 Commercial Edition v2.1 - Content Registry (content.js)
 * Pure Data definitions for Puzzles, Upgrades, Dialogues, and AI Patterns.
 */

export const puzzles = [
    {
        id: 'wifi',
        title: '장애 #1: 사무실 Wi-Fi 연결 끊김',
        choices: [
            {
                key: 'ping',
                cmd: 'ping 8.8.8.8',
                label: '1. ping 8.8.8.8 (안전한 SRE 진단)',
                isFairDiagnostic: true,
                rewardTuna: 1,
                techDebtPercent: 0
            },
            {
                key: 'top',
                cmd: 'top / ip link',
                label: '2. top / ip link (근본 원인 분석)',
                isFairDiagnostic: true,
                rewardTuna: 2,
                techDebtPercent: 0
            },
            {
                key: 'systemctl',
                cmd: 'systemctl restart nginx',
                label: '3. systemctl restart nginx (무작정 재시작)',
                isFairDiagnostic: false,
                rewardTuna: 0,
                techDebtPercent: 15
            }
        ]
    },
    {
        id: 'cpu',
        title: '장애 #2: 서버 #4 고CPU 경보',
        choices: [
            {
                key: 'ip_link',
                cmd: 'ip link show / top',
                label: '1. top / ip link show (PID 1337 점검)',
                isFairDiagnostic: true,
                rewardTuna: 1,
                techDebtPercent: 0
            },
            {
                key: 'kill',
                cmd: 'kill -9 1337',
                label: '2. kill -9 1337 (마이너 종료)',
                isFairDiagnostic: true,
                rewardTuna: 2,
                techDebtPercent: 0
            },
            {
                key: 'reboot',
                cmd: 'reboot',
                label: '3. reboot (피크 시간 재부팅)',
                isFairDiagnostic: false,
                rewardTuna: 0,
                techDebtPercent: 20
            }
        ]
    },
    {
        id: 'ssh',
        title: '장애 #3: 골든 티켓 SSH 침입',
        choices: [
            {
                key: 'auth_log',
                cmd: 'cat /var/log/auth.log',
                label: '1. cat /var/log/auth.log (로그 감사)',
                isFairDiagnostic: true,
                rewardTuna: 1,
                techDebtPercent: 0
            },
            {
                key: 'altman',
                cmd: 'ssh-copy-id sam_altman',
                label: '2. ssh-copy-id sam_altman (탐욕스러운 동맹)',
                isFairDiagnostic: false,
                rewardTuna: 2,
                techDebtPercent: 25
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
