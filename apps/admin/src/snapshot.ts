import type { PersonaStore } from "@ren-ai/personas";
import { PersonaError, serializePersona } from "@ren-ai/personas";
import type { Draft } from "./draft.ts";
import copy from "./copy.json";
import { operation } from "./logging.ts";

export async function assertSnapshot(store: PersonaStore, draft: Draft) {
  if (!draft.base) return;
  const [current, initial] = await Promise.all([
    operation("persona.snapshot.read", { personaId: draft.id }, () =>
      draft.legacySource === undefined
        ? store.get(draft.id).then(serializePersona)
        : store.source(draft.id),
    ),
    draft.initial &&
      operation("persona.initial.read", { personaId: draft.id }, () => store.initial(draft.id)),
  ]);
  if (current !== (draft.legacySource ?? draft.base))
    throw new PersonaError("conflict", copy.stale);
  if (draft.initial && JSON.stringify(initial) !== JSON.stringify(draft.initial.base))
    throw new PersonaError("conflict", "State 또는 Memory가 변경되었습니다. 다시 열어 주세요.");
}
