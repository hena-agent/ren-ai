import type { ImageBatchSnapshot } from "./image-batch.ts";
import type { Draft } from "./draft.ts";

export function artworkBatchFields(
  snapshot: ImageBatchSnapshot,
  draft: () => Draft,
  prompts: readonly string[],
) {
  return {
    personaId: snapshot.source.id,
    source: snapshot.source,
    slots: [{ style: "anime" as const, index: 0 }],
    prompts,
    draft,
    record: () => snapshot.source,
  };
}
