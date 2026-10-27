import type {
  IdentitySheets,
  InitialDocuments,
  PersonaRecord,
  PersonaStore,
} from "@ren-ai/personas";
import { operation } from "./logging.ts";

export interface EditorRecord {
  record: PersonaRecord;
  sheets: IdentitySheets;
  initial?: InitialDocuments | undefined;
}

/** Independent reads share one Catalog round trip instead of waiting on each other. */
export async function readEditor(store: PersonaStore, id: string): Promise<EditorRecord> {
  const [record, sheets, initial] = await Promise.all([
    operation("persona.get", { personaId: id }, () => store.get(id)),
    operation("identity.sheets.read", { personaId: id }, () => store.sheets(id)),
    operation("persona.initial.read", { personaId: id }, () => store.initial(id)),
  ]);
  return { record, sheets, initial };
}
