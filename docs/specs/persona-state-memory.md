# Persona 상태와 기억 (설계안)

Persona는 OpenCode session에서 실행한다. 현재 상태는 tool로 변경하고, 단기 기억은 system prompt에 넣으며, 장기 기억은 필요할 때 tool로 검색한다. 이 문서의 런타임 읽기·갱신 흐름은 구현 계획이다. 아래의 Admin 공통 초기값 작성은 구현되어 있다.

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

### Admin에서 공통 초기값 작성

- Persona 편집 화면의 **Persona / State / Memory** 탭에서 원문과 공통 초기값을 관리한다. 새 session의 초기값과 실제 OpenCode 상태·기억 연결은 포함하지 않는다.
- 첫 Persona 생성은 초기 State·Memory까지 한 생성 요청으로 작성하고 함께 검수한다. 이후 **Persona로 State 다시 생성**, **Persona로 Memory 다시 생성**은 현재 편집 중인 비공개 시트를 입력해 해당 문서만 만드는 텍스트 요청 1회다. 공개 글·다른 초기 문서·사진은 보내지 않는다. 상태 5개는 인물의 성향과 생활에 맞는 정수 0–100이며 고정 성향을 복사하거나 모두 50으로 채우지 않는다.
- `traits`는 시트에 정의한 숨겨진 특성의 이름·강도를 그대로 가져오고 `active: true`, `persistence: lasting`으로 시작한다. 현재 시트에는 별도 특성 ID가 없으므로 YAML key에 특성 이름을 쓴다. 특성이 없으면 빈 객체다. 저장 시 이름·강도 일치를 검증한다.
- `MEMORY.md`는 `# 현재 생활`로 시작한다. 명시된 생활·목표를 우선하고, 모순 없는 진행 중인 생활·관심사·가까운 목표는 보강할 수 있다. 사용자 사실·상대와의 경험·약속·관계 상태·근거 사건·형성된 특성은 만들지 않는다. 보강은 실제 경험 기록이 아니라 운영자가 확인할 창작 출발 설정이다.
- 세 원문을 CodeMirror에서 수정하고 상단 **저장**으로 확정한다. 탭 전환은 입력·커서·실행 취소를 유지한다. 생성·재생성은 편집 초안이며 실패하면 기존 파일과 입력을 유지한다. Persona 변경만으로 초기값을 덮어쓰지 않는다. 특성 이름·강도를 바꾼 경우 초기값도 맞춰 수정하거나 다시 생성한다.
- 저장 경로는 기존 `{id}.md` 옆의 `initial/{id}/STATE.md`·`MEMORY.md`다. 두 파일은 비공개이며 인증된 다운로드만 제공한다. 기존 `memory` frontmatter는 런타임 기억 지침으로, 새 생활 기억과 별개다.
- 파일 쌍은 `initial/.{revision}/`의 실제 Markdown 두 개를 먼저 쓰고 `initial/{id}` 상대 symlink를 원자적으로 교체해 함께 확정한다. 읽기는 symlink를 한 번 해석하여 같은 revision의 파일 쌍을 읽는다. 이전 revision은 진행 중 읽기와 복구를 위해 보관한다. 백업은 숨겨진 revision과 symlink를 포함한 `initial/` 전체를 보관한다.
- 통합 저장은 Persona 파일을 마지막에 확정한다. Persona 확정이 실패하면 초기값 포인터를 복구하며, 복구도 실패할 때는 두 원인과 최초 확정 실패의 cause를 보존한다. 공개 저장은 세 문서의 실제 형식·상태와 특성 일치·생활 기억의 내용·공개 자기소개·사진을 모두 검사한다. 미완성 초기값은 비공개 초안으로 보관할 수 있다. 기존 공개 목록은 유지하고 다음 공개 저장부터 조건을 강제한다.
- Persona 원본과 초기값의 서명된 스냅샷을 비교해 오래된 화면의 생성·저장을 거부하고, 생성 후에도 원본을 다시 검사한다. 이미지 실행·대기 중에는 초기값 편집·생성·저장을 잠근다. 초기값 작업 중에도 같은 Persona의 원본 변경과 이미지 요청을 막는다.
- 생성·검증·저장 실패는 요청 ID·단계·모델·오류 코드·원인과 함께 기록한다. 시트·상태·생활 기억·서명 draft·provider payload는 로그와 공개 응답에서 제외한다.

### 런타임 읽기·갱신 (계획)

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
