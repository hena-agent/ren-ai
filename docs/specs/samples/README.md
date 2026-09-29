# Persona 상태·기억 샘플

[설계안](../persona-state-memory.md)을 하린과 지우의 초기값으로 펼친 예시다. 원본은 [`personas.ts`](../../../apps/persona-lab/src/personas.ts)이며, 이 파일들은 실제 서비스 데이터가 아니다.

`PERSONA.md`는 고정 설정과 새 상태의 시작값을 정의한다. Persona 공통 `STATE.md`는 인물의 현재 상태, `sessions/sample-session/STATE.md`는 해당 OpenCode session의 가변 성격·관계·서운함·숨겨진 특성의 공개 여부를 담는다. 새 session은 `PERSONA.md`의 session 시작값으로 만들며 기존 상태를 다시 초기화하지 않는다.

각 범위의 `MEMORY.md`에는 지금 유효한 생활·관계 기억만 둔다. 초기 장기기억에는 근거 있는 사건이 없으므로 `long-term/`은 비어 있다. 사건을 겪으면 해당 범위에 근거와 함께 기록한다. `sample-session`은 예시 이름이지 실제 OpenCode session ID가 아니다.
