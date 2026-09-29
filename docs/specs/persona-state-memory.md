# Persona 상태와 기억 (설계안)

Persona는 OpenCode session에서 실행한다. 현재 상태는 tool로 변경하고, 단기 기억은 system prompt에 넣으며, 장기 기억은 필요할 때 tool로 검색한다. 이 문서는 구현 계획이며 현재 동작을 설명하지 않는다.

## 파일과 범위

```text
personas/{persona-id}/
  PERSONA.md
  STATE.md
  MEMORY.md
  long-term/*.md
  sessions/{opencode-session-id}/
    STATE.md
    MEMORY.md
    long-term/*.md
```

| 파일             | 담는 것                                    | 범위                                         |
| ---------------- | ------------------------------------------ | -------------------------------------------- |
| `PERSONA.md`     | 인물의 정체성, 기본 성향, 말투와 원칙      | Persona 공통, 운영자가 관리                  |
| `STATE.md`       | 구조화된 현재값                            | Persona 공통 상태 / 해당 session의 관계 상태 |
| `MEMORY.md`      | 항상 떠올릴 단기 기억, 진행 중인 일과 약속 | Persona 공통 기억 / 해당 session만의 기억    |
| `long-term/*.md` | 지나간 경험과 근거                         | Persona 공통 경험 / 해당 session만의 경험    |

Persona 폴더의 `STATE.md`와 `MEMORY.md`는 모든 session이 같은 파일을 읽고, session 폴더의 파일은 해당 session만 읽는다. 특정 상대의 사실·관계·약속은 session 폴더에만 둔다. 기본 성향은 `PERSONA.md`에 두고 현재값처럼 갱신하지 않는다.

## 읽고 쓰기

- 매 실행 시 `PERSONA.md`와 공통·session별 `STATE.md`·`MEMORY.md`를 system prompt에 넣는다. 대화 이력은 OpenCode session이 관리하며 메시지 원문을 Markdown에 복사하지 않는다.
- 장기 기억은 상시 주입하지 않는다. `search_memory`는 Persona 공통 기억과 현재 OpenCode session의 기억에서만 검색한다. 검색 결과에는 출처를 포함한다.
- `update_state`만 상태를 변경한다. 허용 필드·값·관계 단계 규칙을 검증하고 해당 범위에 저장한다.
- `update_memory`는 단기 기억을 갱신하고, `remember`와 `supersede_memory`는 장기 기억을 기록·정정한다. 정정된 기억은 현재 유효한 내용으로 찾을 수 있어야 한다.

```text
메시지 또는 사건 → OpenCode session
  ├─ PERSONA.md + 공통/해당 session의 STATE.md·MEMORY.md → 항상 읽음
  ├─ search_memory → 필요한 장기 기억만 검색
  └─ update_state / update_memory / remember → 필요한 변경만 저장
```

파일 갱신 시 다른 session의 기억이 섞이거나, 같은 입력으로 상태가 중복 변경되어서는 안 된다. 검색은 우선 Markdown 파일에서 시작하고, 검색 방식은 필요할 때 tool 뒤에서 바꾼다. 발신·수신 등 운영 기록은 기존 서버가 관리한다.

[하린·지우의 초기 파일 예시](samples/README.md)는 `apps/persona-lab/src/personas.ts`의 시작값을 이 구조에 배치한 것이다. 새 OpenCode session의 상태는 각 Persona의 시작값으로 만들고, 기존 상태를 매 실행마다 덮어쓰지 않는다.

기존 [OpenCode session 결정](../adr/0002-each-conversation-has-one-lifelong-opencode-session.md)과 [서버 DB 분리 결정](../adr/0006-the-server-keeps-its-own-sqlite-file-apart-from-opencodes.md)은 유지한다. 현재 [도메인 용어](../../CONTEXT.md)의 Memory는 최근 대화 원문과 압축 요약을 뜻한다. 파일 기반 기억을 구현할 때 OpenCode 압축 요약과의 역할 및 용어 정의를 맞춘다.
