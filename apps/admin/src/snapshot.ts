import type { createPersonaStore } from "@ren-ai/personas";
import { PersonaError, serializePersona } from "@ren-ai/personas";
import type { Draft } from "./draft.ts";
import copy from "./copy.json";

export async function assertSnapshot(
  store: Awaited<ReturnType<typeof createPersonaStore>>,
  draft: Draft,
) {
  if (!draft.base) return;
  let expected = draft.base;
  let current: string;
  if (draft.legacySource === undefined) current = serializePersona(await store.get(draft.id));
  else {
    expected = draft.legacySource;
    current = await store.source(draft.id);
  }
  if (current !== expected) throw new PersonaError("conflict", copy.stale);
}
