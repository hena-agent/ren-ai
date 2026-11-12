import type {
  IdentitySheets,
  InitialDocuments,
  PersonaRecord,
  PersonaStore,
  RigArtworkImage,
} from "@ren-ai/personas";
import { operation } from "./logging.ts";
import { restoreDraft, type Draft } from "./draft.ts";

export interface EditorRecord {
  record: PersonaRecord;
  sheets: IdentitySheets;
  initial?: InitialDocuments | undefined;
  artwork?: RigArtworkImage | undefined;
}

export function editorDraft(
  loaded: EditorRecord | undefined,
  editing: boolean,
  cached: Draft | undefined,
) {
  if (!loaded) return undefined;
  let draft = { ...restoreDraft(loaded.record, editing, cached), sheets: loaded.sheets };
  if (loaded.artwork)
    draft = {
      ...draft,
      rigArtwork: {
        model: draft.rigArtwork?.model ?? loaded.artwork.model,
        image: loaded.artwork,
      },
    };
  if (editing && !draft.initial) {
    const initial = loaded.initial;
    draft = { ...draft, initial: initial ? { base: initial, preview: initial } : {} };
  }
  return draft;
}

/** Independent reads share one Catalog round trip instead of waiting on each other. */
export async function readEditor(store: PersonaStore, id: string): Promise<EditorRecord> {
  const [record, sheets, initial, artwork] = await Promise.all([
    operation("persona.get", { personaId: id }, () => store.get(id)),
    operation("identity.sheets.read", { personaId: id }, () => store.sheets(id)),
    operation("persona.initial.read", { personaId: id }, () => store.initial(id)),
    operation("rig.artwork.read", { personaId: id }, () => store.rigArtwork(id)),
  ]);
  return { record, sheets, initial, artwork };
}
