# Persona 상태·기억 샘플

[상태·기억 계약](../persona-state-memory.md)을 하린과 지우의 초기값으로 펼친 예시다. 인물 원본은 [`personas.ts`](../../../apps/persona-lab/src/personas.ts)이며, 이 파일들은 실제 서비스 데이터가 아니다.

인물 루트의 `STATE.md`·`MEMORY.md`는 Catalog 초기값 예시다. 첫 Conversation에서 공유 State·Life memory를 한 번 초기화하고 이후 Conversation은 그 현재값을 함께 사용한다. `affection`은 하린 15·지우 20의 출발 호감도로, 새 Conversation의 사적인 Relationship state에만 복사하며 이미 쌓인 친숙함이나 신뢰가 아니다. 사용자 사실·약속·대화 이력도 해당 Relationship 범위에만 둔다. 기존 문서는 초기값 편집으로 다시 초기화하지 않는다. `PERSONA.md`와 `sessions/sample-session/`은 Persona Lab의 인물·관계 축 예시이며 현재 OC 런타임 소유권과 저장 형식은 [ADR-0023](../../adr/0023-personas-share-one-life-across-up-to-five-conversations.md)과 위 계약을 따른다.

초기 `MEMORY.md`에는 현재 생활만 둔다. 상대와의 사실·경험·약속은 Conversation이 진행된 뒤 해당 Conversation에 기록한다. 초기 장기기억에는 근거 있는 사건이 없으므로 `long-term/`은 비어 있다. `sample-session`은 예시 이름이지 실제 OpenCode session ID가 아니다.
