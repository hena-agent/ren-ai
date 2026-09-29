# Agent lifecycle: 입력부터 다음 대기까지

[원본 스펙](agent-runtime.md) · [Context 주입 구조](agent-runtime-architecture.md) · [단계별 API 호출](agent-runtime-api-flow.md)

이것은 **장기 설계의 전체 실행 흐름**이다. 중앙에서 매 턴 담당 Agent를 선택하지 않는다. 대화와 Persona 상태는 지속 기록으로 남고, Persona·Life·Kizuna는 **각자의 관찰 위치와 확인 시각**에 따라 따로 깨어난다. Advisor만 유저가 호출할 때 실행한다. 한 Agent가 내려가 있어도 다른 Agent의 관찰·판단은 계속된다. 실제 HTTP 경로와 프로세스 배치는 아직 정하지 않았다.

## 네 Agent가 각각 이어가는 흐름

```mermaid
flowchart TB
    USER["유저"] -->|실제 메시지| IM["iMessage 원문 · GUID"]
    IM -->|누락 재수집 · 중복 제거| VIEW[("확정된 Conversation<br/>Persona의 확정 상태 · 버전")]

    subgraph PERSONA["Persona · 자기 경험의 시점"]
        direction LR
        PW["메시지 · 확정 사건 · 자기 시각에 깨어남"] --> PR["자기 대화·상태·기억을 읽고 판단"] --> PC["자기 상태·기억·행동 의도 확정<br/>관찰 위치 저장 · 다시 대기"]
    end

    subgraph LIFE["Life · 일상 관찰자"]
        direction LR
        LW["대화/상태 변화 · 일정 · 외부 선택을 확인"] --> LR["대화 + Persona 상태 + 생활 사실을 읽고 판단"] --> LC["일정·외부 사건 확정<br/>관찰 위치 저장 · 다시 대기"]
    end

    subgraph KIZUNA["Kizuna · 관계 관찰자"]
        direction LR
        KW["대화/상태 변화 · 재검토 시각에 확인"] --> KR["대화 + Persona 상태를 읽고 판단"] --> KC["제안 또는 개입하지 않음<br/>관찰 위치 저장 · 다시 대기"]
    end

    subgraph ADVISOR["Advisor · 유저가 호출할 때만"]
        direction LR
        AW["유저가 조언 요청"] --> AR["최신 대화 + Persona 상태 + 질문을 읽음"] --> AC["지인 같은 해석만 유저에게 전달<br/>먼저 연락하거나 상태를 바꾸지 않음"]
    end

    VIEW -->|자신이 아는 범위| PR
    VIEW -->|읽기 전용| LR
    VIEW -->|읽기 전용| KR
    VIEW -->|호출 시 읽기 전용| AR
    IM -->|새 메시지 알림| PW
    VIEW -->|대화·상태 변화 알림 또는 자체 확인| LW
    VIEW -->|대화·상태 변화 알림 또는 자체 확인| KW
    USER -->|명시적 호출| AW
    PC -->|확정된 상태 변경| VIEW
    PC -->|답장 의도| OUT[("Outbox · 발신 기록")]
    PC -->|외부에 실행한 선택의 기록| LW
    OUT -->|Conversation에 묶인 발신/대조| IM
    KC -->|유효 기간이 있는 제안| LW
    LC -->|Persona가 알 수 있는 확정 사건만| PW
    AC -->|조언| USER

    classDef source fill:#e7f1ff,stroke:#477aad,color:#142c46
    classDef state fill:#eef1f5,stroke:#66758a,color:#233044
    classDef persona fill:#eee8fa,stroke:#8056b2,color:#2c1c40
    classDef life fill:#e8f5e8,stroke:#44885a,color:#1b3b29
    classDef kizuna fill:#fde8ee,stroke:#b65578,color:#4c2634
    classDef advisor fill:#fff1df,stroke:#bd7d34,color:#54361c
    class USER,IM source
    class VIEW,OUT state
    class PW,PR,PC persona
    class LW,LR,LC life
    class KW,KR,KC kizuna
    class AW,AR,AC advisor
```

**핵심:** `VIEW`는 공유 프롬프트나 중앙의 턴 진행자가 아니라, 각 Agent가 **자기 시각에 읽는 확정된 대화·상태**다. Persona는 자신의 기억과 알게 된 사실을 더해 판단한다. Life·Kizuna·Advisor도 대화와 상태를 보되 각각 자기 Context에서 판단한다. `KC → LW`는 Life가 제안을 검토할 계기이지, 둘이 같은 턴에 실행된다는 뜻이 아니다. Persona의 답장을 확정한 뒤 Agent가 내려가도 발신 작업자는 Outbox를 처리한다. 결과가 불명확하면 [채널 대조](agent-runtime-api-flow.md#3-발신-persona의-의도와-실제-전송-사이) 전 재전송하지 않는다.

## 한 Agent의 실행 상태

위 도면에서 각 Agent에 **따로 적용되는** 상태 전이다. Persona·Life·Kizuna는 자신에게 의미 있는 새 관찰이나 확인 시각으로 깨어나고, Advisor는 유저의 요청으로만 깨어난다. Life가 멈춘다고 Persona까지 내려가는 단일 프로세스 모델이 아니다.

```mermaid
stateDiagram-v2
    direction LR
    state "대기 · 실행 프로세스 없음" as Idle
    state "미처리 입력 보존" as Queued
    state "선점 · Context 복원" as Prepared
    state "자기 Context에서 판단" as Deciding
    state "결과 확정됨" as Committed
    state "중단됨" as Down
    state "확정 결과 대조" as Recovering

    [*] --> Idle
    Idle --> Queued: 자기 관찰·확인 시각 또는 Advisor 호출
    Queued --> Prepared: claim
    Prepared --> Deciding: 자신의 관찰 위치·대화·상태·Context 조립
    Deciding --> Prepared: 새 입력·버전 충돌
    Deciding --> Committed: 판단과 자기 관찰·처리 위치 확정
    Committed --> Idle: 이번 실행 종료
    Committed --> Queued: 후속 입력 남음
    Prepared --> Down: 중단·오류
    Deciding --> Down: 중단·오류
    Committed --> Down: 확정 직후 중단
    Down --> Recovering: 재시작
    Recovering --> Queued: 아직 미확정인 입력 있음
    Recovering --> Idle: 이미 확정됐고 새 입력 없음
```

## 각 역할이 한 번 깨어나는 이유와 다음 입력

| 역할        | 깨우는 계기                                                                        | Context에 들어가는 것                                                                                | 확정 결과가 다음에 가는 곳                                      |
| ----------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Persona** | 쌓인 유저 메시지, Persona가 알게 된 생활 사건, 재검토 시각                         | 인물 설정·상태, 해당 Conversation의 Core/단기, 필요할 때만 검색한 장기 기억, 시각순 원문과 확정 사건 | 기억/상태 갱신, 발신 의도는 Outbox, 외부 행동은 Life의 입력     |
| **Life**    | 새 대화·Persona 상태 변화, 일정·시간 도래, Persona의 외부 선택, 유효한 Kizuna 제안 | 실제 대화·Persona의 확정 상태 + 확정 일정·주변 사실·Persona의 외부 선택                              | 확정 사건만 Persona의 영속 입력함; 채택·폐기는 Kizuna 작업 기록 |
| **Kizuna**  | 새 대화·Persona 상태 변화, 재검토 시각                                             | 실제 대화·Persona의 확정 상태 + 기존 제안·근거 사건                                                  | 계기 제안은 Life의 입력; 개입하지 않으면 후속 사건 없음         |
| **Advisor** | 유저의 명시적 조언 요청만                                                          | 호출 시 최신 Conversation·Persona의 확정 상태·유저의 질문                                            | 지인 같은 조언만 유저에게 전달; Persona에게 전달하지 않음       |

Persona의 한 실행에서는 `context.md`의 **Core·단기를 항상** 읽고, 장기 DB는 **Persona·Conversation·인물 ID로 범위를 확인한 뒤 필요할 때만** 검색한다. `민서 (인물 ID: p-42)`의 기억을 이름만 같은 다른 사람에게 주입하지 않는다. Life·Kizuna·Advisor가 상태를 읽을 수 있다는 것이 다른 Agent의 비공개 작업 기록이나 Persona의 주관적 기억 전체를 공유한다는 뜻은 아니다. Kizuna의 기획 의도와 Advisor의 비공개 상담도 Persona에게 전달하지 않는다.

## 복귀 지점은 어디인가

| 중단 시점                          | 복귀 시 확인하는 것                                 | 이어서 할 일                                                         |
| ---------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| 수신 전·중                         | iMessage 기록과 수신 북마크                         | 누락 메시지를 다시 읽고 GUID로 중복 제거                             |
| Agent 선점 전 또는 판단 중         | 영속 입력함, 확정 버전, 이미 처리된 입력 ID         | 미처리 입력만 현재 시각에서 판단; 확정된 판단을 다시 생성하지 않음   |
| 판단 확정 후, 기억 파일 갱신 중    | 확정 버전과 `context.md`/장기 DB 버전·근거          | 확정된 기억 변경을 대조·복구; 같은 감정 변화를 재적용하지 않음       |
| 발신 전 또는 직후                  | Outbox의 의도·시도·확인 상태와 채널 기록            | 결과 불명확이면 해당 Conversation의 다음 발신을 보류하고 채널과 대조 |
| 오랜 시간 Life·Kizuna·Advisor 중단 | 확정 일정, 제안 유효 기간, 조언 요청 뒤의 최신 대화 | 지나간 일은 따라잡되 낡은 제안·조언을 무작정 실행하지 않음           |

예: Persona가 내려간 13:10·13:15·13:40에 `민서 (인물 ID: p-42)`가 오늘 약속을 제안했다가 취소하고 내일로 바꾸었다. 14:00에 복귀하면 세 메시지의 원문과 발생 시각을 보존한 채 **지금도 유효한 내일 제안**을 보고 판단한다. 장애로 늦게 답했다고 민서의 무응답이나 Persona의 의도적인 무시로 해석하지 않는다.

이 도면의 `claim`, Context 조립, `commit`, Outbox 대조에 대응하는 논리적 호출과 모델 왕복은 [API 호출 순서](agent-runtime-api-flow.md)에 있다. **현재 ADR의 메시지별 프롬프트를 누적 판단과 어떻게 결합할지는 아직 미결정**이며, 도면이 새 전송 형식을 확정하지 않는다.
