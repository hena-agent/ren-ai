# Agent 실행 · Context 주입 · 호출 순서

[Agent lifecycle · 전체 흐름](agent-runtime-lifecycle.md) · [구성요소 아키텍처](agent-runtime-architecture.md) · [원본 스펙](agent-runtime.md)

**장기 방향의 논리적 API 호출도**다. `inputs.appendOnce` 같은 이름은 역할 사이의 계약을 보여 주기 위한 표기이며, 실제 HTTP 경로·프로세스 개수·데이터베이스 테이블을 확정하지 않는다. `DB`는 서비스의 지속 상태를 뜻하고, iMessage의 실제 Conversation 원문은 채널에서 확인한다. Persona·Life·Kizuna는 같은 대화·상태 변화를 **서로 다른 관찰 위치와 시각**에서 읽는다. 모델 호출은 각 Agent의 **자기 Context**만 사용하며, Advisor는 유저가 호출할 때만 실행한다.

## 1. 채널에서 받은 메시지를 잃지 않기

```mermaid
sequenceDiagram
    autonumber
    participant IM as iMessage 기록
    participant RX as 수신기
    participant DB as 입력·북마크 저장소
    participant P as Persona 관찰 위치
    participant L as Life 관찰 위치
    participant K as Kizuna 관찰 위치

    IM->>RX: channel.readSince(bookmark)
    IM-->>RX: Message {guid, conversationId, personId, text, occurredAt}[]
    loop 각 메시지 · GUID 순서
        RX->>DB: inputs.appendOnce(guid, conversationId, personId, text, occurredAt)
        DB-->>RX: accepted 또는 alreadyExists
    end
    RX->>DB: bookmark.advance(보존 확인된 위치)
    DB-->>P: conversationChanged(conversationId, version) · 힌트
    DB-->>L: conversationChanged(conversationId, version) · 힌트
    DB-->>K: conversationChanged(conversationId, version) · 힌트
    Note over IM,DB: 수신기가 내려가도 채널 원문에서 다시 읽는다. 재수신은 동일 GUID로 중복 제거한다.
    Note over P,K: 세 Agent가 같은 턴을 순서대로 수행하지 않는다. 각각 나중에 자신의 위치부터 확인한다.
```

수신 사실을 기록하기 전에 처리 위치부터 진행시키지 않는다. `personId`는 현재 유저를 식별하는 안정적인 ID이며, 이름이나 Handle과 혼용하지 않는다. 위 신호는 실행을 돕는 힌트일 뿐이다. Life와 Kizuna는 대화·상태 변경을 각자 관찰하고, 신호가 유실되어도 자기 관찰 위치부터 다시 읽는다. Advisor에는 신호를 보내지 않는다. Persona가 이미 메시지를 읽었지만 답하지 않기로 했더라도, **입력을 처리한 것**과 **발신한 것**은 별개로 보존한다.

## 2. Persona가 실행될 때: 읽기 → 주입 → 판단 → 확정

```mermaid
sequenceDiagram
    autonumber
    participant RUN as Persona 전용 실행
    participant DB as 상태·입력 저장소
    participant CTX as Conversation별 context.md
    participant MEM as 장기 기억 DB
    participant P as Persona Agent
    participant MODEL as Persona의 모델

    RUN->>DB: claim(personaId, conversationId, 관찰 위치, expectedVersion)
    DB-->>RUN: 최신 개인·관계 상태, 미처리 메시지[], 확정 사건[], version
    RUN->>CTX: read(conversationId)
    CTX-->>RUN: Core, 단기 기억, 파일 버전
    opt 현재 맥락에 관련된 과거 경험이 필요함
        RUN->>MEM: search(personaId, conversationId, personIds[], query)
        Note over RUN,MEM: Persona · Conversation · 인물 ID 범위를 먼저 검사한 뒤 관련성·현재 효력으로 검색
        MEM-->>RUN: 관련 경험[] 또는 [] · 사실/해석/근거/시각
    end
    RUN->>P: persona.run(설정, 상태, Core, 단기, 관련 경험, 입력[], 확정 사건[], now)
    P->>MODEL: infer(위 정보만 포함한 Persona Context)
    MODEL-->>P: 행동 · 말할 내용 · 기억/상태 변경안
    P-->>RUN: decision {action, reply?, changes, memoryChanges}
    RUN->>DB: commitIfVersion(version, decision, processedIds[], followUps[], sendIntent?)
    alt 생성 중 새 입력·상태 변경으로 버전 충돌
        DB-->>RUN: conflict
        RUN->>RUN: 최신 입력으로 재조립 · 오래된 발신안 폐기
    else 판단 확정
        DB-->>RUN: committedVersion · outboxId?
        RUN->>CTX: materialize(committedVersion, Core, 단기 변경)
        RUN->>MEM: applyOnce(committedVersion, 근거 있는 장기 기억·Core 연결)
        Note over DB,MEM: 파일/DB가 어긋나면 확정 버전·근거로 복구 · 같은 입력의 기억 변화 중복 금지
    end
```

**주입되는 모습의 예시** (`c-17`과 `p-42`는 예시 ID):

```text
Persona 설정: 하린의 말투·가치관·알 수 있는 범위
Conversation 범위: c-17 / 민서 (인물 ID: p-42)
확정 상태: 지금의 개인 상태와 민서와의 관계
Core: 민서가 발표 이야기를 재촉하지 않고 들어줬다. 나는 더 솔직해져도 괜찮겠다고 느낀다. (근거 e-17)
단기: 내일 발표가 있다. 민서의 마지막 질문에는 아직 답하지 않았다.
관련 장기 기억: 발표 준비에 대한 사실 / 당시의 내 해석 / 출처·시각 (검색된 경우에만)
새 입력: [13:10 약속 제안, 13:15 시간 확인, 13:40 오늘 취소·내일 제안] 원문 그대로
확정 생활 사건: Persona가 이미 알게 된 사건만
현재 시각: 14:00
```

이는 **전달 정보의 예시**이지 확정된 프롬프트 형식이 아니다. Core·단기는 항상, 장기는 필요한 경우에만 들어간다. 이름 `민서`만으로 다른 사람의 기억을 검색하지 않으며 `유저가 ...` 같은 모호한 기억을 만들지 않는다. Kizuna의 기획 이유, Life의 미확정 후보, Advisor 상담은 주입하지 않는다. Persona가 대답 대신 기다리기로 해도 변경안과 처리 위치는 한 번만 확정된다.

`commitIfVersion`은 **논리적으로 하나의 확정 단계**다. `context.md`와 DB는 서로 다른 매체이므로 물리적 단일 트랜잭션을 가정하지 않는다. 어떤 확정 버전에서 파일을 다시 만들어야 하는지, 실패 시 어떻게 대조할지는 구현에서 정해야 한다. 발신은 이 단계가 끝나기 전에 시작하지 않는다.

확정된 Persona 상태 변화는 Life와 Kizuna가 **각자의 관찰 위치에서 나중에 확인할 새 버전**이 된다. 이 커밋이 Life나 Kizuna의 모델을 즉시 호출하지 않으며, Advisor도 자동으로 실행하지 않는다.

## 3. 발신: Persona의 의도와 실제 전송 사이

```mermaid
sequenceDiagram
    autonumber
    participant DB as Outbox·발신 기록
    participant SEND as 발신 작업자
    participant IM as iMessage 채널
    participant RUN as Persona 전용 실행

    SEND->>DB: outbox.claim(conversationId, outboxId)
    DB-->>SEND: 발신 의도 · 서비스가 고정한 대상 Handle
    SEND->>DB: outbox.checkStillValid(outboxId, 최신 입력 버전)
    alt 보내기 전 새 메시지로 내용이 낡음
        DB-->>SEND: stale
        SEND->>DB: outbox.cancel(outboxId)
        SEND-->>RUN: wake(conversationId) · 최신 맥락에서 재판단
    else 여전히 유효함
        DB-->>SEND: valid
        SEND->>IM: channel.send(대상 고정, 발신 내용)
        alt 발신 확인됨
            IM-->>SEND: sent · 채널 메시지 ID
            SEND->>DB: outbox.confirmSent(outboxId, 채널 메시지 ID)
        else 발신하지 않은 것이 확인됨
            IM-->>SEND: notSent
            SEND->>DB: outbox.recordNotSent(outboxId) · 안전한 재시도 대상
        else 결과 불명확 · 작업자 중단 포함
            SEND->>DB: outbox.markInDoubt(outboxId)
            DB-->>RUN: 해당 Conversation의 후속 발신 보류
            RUN->>IM: channel.lookup(Conversation, 발신 의도·시각)
            IM-->>RUN: sent / notSent / 아직 불명확
            RUN->>DB: reconcile(outboxId, 확인된 사실)
        end
    end
```

Persona는 수신자나 셸 명령을 선택하지 않는다. 서비스가 해당 Conversation에 묶인 대상에게만 발신한다. **결과 불명확 ≠ 실패 확정**이므로 재전송 전에 채널 기록과 대조한다. 답장 예약 뒤 새 메시지가 쌓인 경우 기존 발신안의 유효성을 다시 판단한다.

## 4. 관계 이벤트와 일상의 API 경계

```mermaid
sequenceDiagram
    autonumber
    participant KWORK as Kizuna 전용 실행
    participant DB as 대화·상태·관찰 위치·일정
    participant K as Kizuna Agent
    participant MODEL as 각 Agent의 모델
    participant LWORK as Life 전용 실행
    participant L as Life Agent
    participant IN as Persona의 입력함

    Note over KWORK,LWORK: 두 Agent는 같은 턴에 함께 실행하지 않는다. 각자 새 대화·상태와 자신의 확인 시각을 관찰한다.
    KWORK->>DB: observeSince(kizunaCursor, conversationId)
    DB-->>KWORK: 실제 대화, Persona 확정 상태, 기존 제안, 최신 버전
    KWORK->>K: kizuna.consider(대화, 상태, 시각, 기존 제안)
    K->>MODEL: infer(대화 · 상태 · Kizuna 전용 Context)
    MODEL-->>K: 개입 여부 · 계기 후보
    alt 이번에는 개입하지 않음
        K-->>KWORK: noProposal
        KWORK->>DB: kizuna.commit(관찰 위치, 개입 없음)
    else 계기 제안
        K-->>KWORK: proposal {id, situation, expiresAt}
        KWORK->>DB: kizuna.commit(관찰 위치, proposal.saveOnce)
    end

    Note over DB,LWORK: 나중에 Life의 시각이 도래하거나 관찰할 변경이 생겼을 때
    LWORK->>DB: observeSince(lifeCursor, conversationId, schedule)
    DB-->>LWORK: 실제 대화, Persona 확정 상태, 일정·주변 사실, 외부 선택, 유효 제안
    LWORK->>L: life.advance(대화, 상태, 현재 시각, 일정, 제안?)
    L->>MODEL: infer(대화 · 상태 · 생활 사실 · Life 전용 Context)
    MODEL-->>L: 사건 후보와 외부 결과
    L-->>LWORK: confirmedEvents[] · 일정 변경 · 제안 채택/폐기
    LWORK->>DB: life.commitOnce(관찰 위치, 사건 ID[], 일정, 제안 상태)
    DB-->>IN: appendOnce(확정 사건 ID, 관찰 가능한 사실, 발생 시각)
    Note over K,IN: Kizuna의 제안 이유·버려진 후보·강제 감정은 Persona 입력에 넣지 않는다.
```

Kizuna가 멈춰도 Life의 일상과 Persona의 대화는 이어진다. Life가 멈춰도 Kizuna는 대화·상태를 관찰하고 제안을 남길 수 있으며 Persona는 이미 확정된 사실로 대화한다. 각 역할은 복귀할 때 자기 관찰 위치와 현재 상태를 다시 읽고 오래된 제안을 전부 실행하는 대신 **현재도 유효한지** 확인한다. 둘 다 Persona의 감정·답장 내용을 지정하지 않는다.

## 5. Advisor: 별도 요청·별도 결과

```mermaid
sequenceDiagram
    autonumber
    participant U as 유저
    participant API as Advisor 접점 · 형태 미정
    participant DB as 요청·Persona 상태·전달 기록
    participant CH as 해당 Conversation의 대화
    participant A as Advisor Agent
    participant MODEL as Advisor의 모델

    U->>API: advice.request(conversationId, question)
    API->>DB: advisor.appendOnce(requestId, question, conversationId)
    API->>CH: readConversation(conversationId, 최신 버전)
    CH-->>API: 실제 대화 원문 · 시각 · 버전
    API->>DB: readPersonaState(conversationId)
    DB-->>API: 확정된 개인·관계 상태 · 버전
    API->>A: advisor.advise(question, 대화, 상태, 요청 시점)
    A->>MODEL: infer(대화 · 상태 · 질문 · Advisor 전용 Context)
    MODEL-->>A: 해석 · 조언안
    A-->>API: 지인 같은 advice · 근거 범위 · 내부 수치·속마음 노출 없음
    API->>DB: request.checkStillRelevant(requestId, 최신 대화·상태 버전)
    alt 요청 이후 상황이 해결되거나 달라짐
        DB-->>API: stale
        API->>DB: 요청 재평가 · 오래된 자동 전달 취소
    else 지금도 유효함
        DB-->>API: valid
        API->>DB: advice.confirmDelivery(requestId)
        API-->>U: 해석·조언
    end
    Note over U,A: 명시적 호출 없이는 실행하지 않는다. Advisor의 존재·답·비공개 상담은 Persona에게 전달하지 않는다.
```

Advisor는 제품 안에서만 두 사람을 아는 지인처럼 조언하는 **호출형 치트키**다. 실제 대화와 Persona의 확정된 상태를 볼 수 있지만, 상태를 유저에게 수치나 확정적인 속마음으로 공개하거나 정답 문장을 지시하지 않는다. 먼저 연락하지 않고 Persona의 세계에 등장하지도 않는다. 접점과 전송 방식은 미결정이며, 위 호출을 확정된 웹 API로 읽지 않는다.

## 6. 중단·재시작 후 같은 사실에서 이어가기

```mermaid
sequenceDiagram
    autonumber
    participant IM as iMessage 기록
    participant SYNC as 채널 수신 복구
    participant DB as 입력·판단·Outbox
    participant RUN as Persona 전용 복구/실행
    participant CTX as context.md · 장기 DB
    participant P as Persona Agent

    Note over IM,P: 13:10 오늘 약속? → 13:15 7시? → 13:40 오늘 취소, 내일은? · Persona는 내려가 있음
    SYNC->>IM: channel.readSince(마지막으로 확정한 bookmark)
    IM-->>SYNC: 아직 등록되지 않은 GUID 포함
    SYNC->>DB: inputs.appendOnce(GUID[]) · 수신 북마크 확정
    DB-->>RUN: 새 입력 변경 힌트 · 놓쳐도 자체 스캔 가능
    RUN->>DB: observeSince(personaCursor) · claim(conversationId, 상태 버전)
    DB-->>RUN: 이미 확정한 판단/미처리 3건/결과 불명확 발신
    RUN->>CTX: read(해당 Conversation의 확정된 Core·단기·관련 장기)
    CTX-->>RUN: 마지막 확정 버전의 기억 · 불일치 시 버전 대조
    RUN->>P: persona.run(세 원문을 시각순으로, 현재 14:00을 명시)
    P-->>RUN: 취소된 오늘 제안 대신 내일에 관한 판단
    RUN->>DB: commitIfVersion(판단, 기억 변경, 처리 위치, 발신 의도?)
    opt 이미 보냈는지 알 수 없는 발신이 있음
        RUN->>IM: channel.lookup(Conversation, 발신 의도)
        IM-->>RUN: sent / notSent / 불명확
        RUN->>DB: reconcile(발신 상태) · 확인 전 다음 발신 보류
    end
    Note over RUN,P: 장애 시간은 의도적 무응답이 아니다. 같은 입력을 재처리해 감정·기억·발신을 중복 적용하지 않는다.
```

같은 복구 시점에 Life와 Kizuna도 **자기 관찰 위치**와 현재 대화·Persona 상태를 각각 대조한다. Life는 지나간 확정 일정을 따라잡고, Kizuna는 시효가 지난 제안을 폐기한다. Advisor는 미처리된 유저의 요청이 있는 경우에만 재개한다. 어느 하나가 복구될 때 다른 Agent의 다음 턴을 중앙에서 순서대로 실행하지 않는다.

이 흐름의 **제품 요구**는 스펙에 있지만, 메시지별 OpenCode 프롬프트를 유지하면서 누적 메시지를 어떻게 함께 판단할지, 세션 압축과 명시적 기억 중 무엇을 복구 기준으로 둘지는 [원본 스펙의 열린 결정](agent-runtime.md#기존-설계와의-접점-및-열린-결정)이다. 위 호출도는 그 결정을 대신하지 않는다.
