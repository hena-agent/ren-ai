import { createHash } from "node:crypto";
import { PersonaError, serializePersona, publicationIssues } from "@ren-ai/personas";
import type { PersonaStore, PersonaRecord, InitialDocuments } from "@ren-ai/personas";
import type { Draft } from "./draft.ts";
import type { SeedingSeed, SeedingRun } from "./seeding-store.ts";
import { savePersonaDraft } from "./save-persona.ts";
import type { createImageQueue } from "./image-queue.ts";
import { operation } from "./logging.ts";

export interface ReviewedSeed extends SeedingSeed {
  selection: string;
  published: boolean;
  imageJobs: { id: string; requestId: string; state: string }[];
}

const fingerprint = (person: PersonaRecord, initial: InitialDocuments | undefined) =>
  `${person.id}:${createHash("sha256")
    .update(serializePersona(person))
    .update(JSON.stringify(initial ?? null))
    .digest("hex")}`;

function publicationDraft(
  person: PersonaRecord,
  initial: InitialDocuments | undefined,
  draft: Draft | undefined,
  selection: string,
): Draft {
  if (selection !== fingerprint(person, initial))
    throw new PersonaError("conflict", "Persona changed after review; reload and review again");
  const source = serializePersona(person);
  if (
    draft &&
    (draft.preview !== source ||
      draft.base !== source ||
      JSON.stringify(draft.initial?.preview) !== JSON.stringify(initial))
  )
    throw new PersonaError("conflict", "Save and review the latest persona edits first");
  if (!person.portraits?.anime || !person.portraits.photo)
    throw new PersonaError("invalid", "Review and save both image styles before publishing");
  if (!initial) throw new PersonaError("invalid", "Initial documents are required");
  if (publicationIssues(person, initial).length)
    throw new PersonaError("invalid", "Review the Persona and initial documents before publishing");
  return {
    id: person.id,
    base: source,
    preview: source,
    initial: { base: initial, preview: initial },
  };
}

export function seedingReview(
  store: PersonaStore,
  drafts: Map<string, Draft>,
  queue: ReturnType<typeof createImageQueue>,
  busy: Set<string>,
) {
  return {
    review: async (seeds: readonly SeedingSeed[]): Promise<ReviewedSeed[]> =>
      Promise.all(
        seeds.map(async (seed) => {
          const result = {
            ...seed,
            selection: "",
            published: false,
            imageJobs: queue
              .list(seed.personaId, "")
              .filter((job) => job.state !== "completed")
              .map(({ id, requestId, state }) => ({ id, requestId, state })),
          };
          if (seed.stage !== "done" && seed.stage !== "partial") return result;
          try {
            const person = await store.get(seed.personaId);
            return {
              ...result,
              published: person.published,
              selection: fingerprint(person, await store.initial(person.id)),
            };
          } catch (cause) {
            if (cause instanceof PersonaError && cause.kind === "not_found") return result;
            throw cause;
          }
        }),
      ),
    publish: async (
      run: SeedingRun,
      seeds: readonly SeedingSeed[],
      selections: readonly string[],
    ) => {
      if (!run.confirmed || !selections.length)
        throw new PersonaError("invalid", "Select completed personas from this run");
      const checked = [];
      const ids = [...new Set(selections.map((selection) => selection.split(":")[0]!))];
      if (ids.some((id) => busy.has(id) || queue.pending(id)))
        throw new PersonaError("conflict", "Persona has pending work");
      for (const id of ids) busy.add(id);
      try {
        for (const selection of new Set(selections)) {
          const id = selection.split(":")[0]!;
          if (
            !seeds.some(
              (seed) =>
                seed.personaId === id && (seed.stage === "done" || seed.stage === "partial"),
            )
          )
            throw new PersonaError("invalid", "Select completed personas from this run");
          checked.push(
            await operation("seeding.publish.validate", { personaId: id }, async () => {
              const person = await store.get(id);
              const initial = await store.initial(id);
              return {
                person,
                draft: publicationDraft(person, initial, drafts.get(id), selection),
              };
            }),
          );
        }
        for (const { person, draft } of checked)
          drafts.set(
            person.id,
            await operation("seeding.publish", { personaId: person.id }, () =>
              savePersonaDraft({ ...person, published: true }, draft, store),
            ),
          );
      } finally {
        for (const id of ids) busy.delete(id);
      }
    },
  };
}
