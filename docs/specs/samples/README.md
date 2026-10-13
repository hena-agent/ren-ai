# Persona 상태·기억 샘플

[상태·기억 계약](../persona-state-memory.md)을 하린과 지우의 초기값으로 펼친 예시다. 인물 원본은 [`personas.ts`](../../../apps/persona-lab/src/personas.ts)이며, 이 파일들은 실제 서비스 데이터가 아니다.

인물 루트의 `STATE.md`·`MEMORY.md`는 신규 Conversation에 복사할 초기값이다. `affection`은 하린 15·지우 20의 출발 호감도로, 이미 쌓인 친숙함이나 신뢰가 아니다. 복사 이후 각 Conversation이 독립적으로 상태·기억을 갱신하며, 공통 파일을 실시간으로 공유하거나 기존 상태를 다시 초기화하지 않는다. `PERSONA.md`와 `sessions/sample-session/`은 Persona Lab의 인물·관계 축을 설명하는 예시이며 현재 OC 런타임 저장 형식은 위 계약을 따른다.

초기 `MEMORY.md`에는 현재 생활만 둔다. 상대와의 사실·경험·약속은 Conversation이 진행된 뒤 해당 Conversation에 기록한다. 초기 장기기억에는 근거 있는 사건이 없으므로 `long-term/`은 비어 있다. `sample-session`은 예시 이름이지 실제 OpenCode session ID가 아니다.
