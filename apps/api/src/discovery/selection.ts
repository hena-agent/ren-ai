import { randomInt } from "node:crypto";
import { Effect } from "effect";
import type { ContactEntry, SelectContacts } from "@ren-ai/onboarding";

export class SelectionConflict extends Error {}
type Input = typeof SelectContacts.Type;
type Entry = typeof ContactEntry.Type;

/** Canonical request identity includes explicit targets; a retry can never change its allocation. */
export const selectionKey = (input: Input) =>
  JSON.stringify({
    count: input.count,
    registrationIDs: input.registrationIDs?.toSorted(),
    assignments: input.assignments?.toSorted((a, b) =>
      a.registrationID.localeCompare(b.registrationID),
    ),
  });

export const selectionChoices = (
  input: Input,
  entries: readonly Entry[],
  available: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    if (input.registrationIDs && input.registrationIDs.length !== input.count)
      return yield* Effect.fail(
        new SelectionConflict("Selection count must match selected registrations"),
      );
    const choices = new Map<string, string>();
    const personas = new Set<string>();
    for (const assignment of input.assignments ?? []) {
      const row = entries.find((entry) => entry.id === assignment.registrationID);
      if (
        !input.registrationIDs?.includes(assignment.registrationID) ||
        !row?.eligible ||
        !available.has(assignment.personaID) ||
        !row.likedPersonas.some((p) => p.id === assignment.personaID) ||
        choices.has(assignment.registrationID) ||
        personas.has(assignment.personaID)
      )
        return yield* Effect.fail(
          new SelectionConflict("Chosen persona is not an available Like for this waiter"),
        );
      choices.set(assignment.registrationID, assignment.personaID);
      personas.add(assignment.personaID);
    }
    return choices;
  });

/** Reserve explicit choices first so a random allocation cannot consume their candidates. */
export const chooseContact = (
  waiting: Entry[],
  available: ReadonlySet<string>,
  choices: ReadonlyMap<string, string>,
) => {
  const fixed = waiting.findIndex((row) => choices.has(row.id));
  const row = waiting.splice(fixed < 0 ? randomInt(waiting.length) : fixed, 1)[0]!;
  const selected = choices.get(row.id);
  const candidates = row.likedPersonas.filter(
    (p) => available.has(p.id) && (!selected || selected === p.id),
  );
  const persona = candidates.length ? candidates[randomInt(candidates.length)]! : undefined;
  return persona && { row, persona };
};
