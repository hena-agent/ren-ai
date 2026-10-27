import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Session } from "@opencode/schema/session";
import { fromPartial } from "@total-typescript/shoehorn";
import type { PersonaRuntime } from "../src/opencode/runtime.ts";
import { conversations } from "../src/conversations/conversations.ts";
import { firstContacts } from "../src/discovery/first-contact.ts";

export const blockedContact = (duringCreation: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let created = 0;
    let removed = 0;
    const host = fromPartial<PersonaRuntime>({
      personas: new Map([["sora", fromPartial({ published: duringCreation })]]),
      createSession: () =>
        Effect.gen(function* () {
          created++;
          yield* sql`INSERT INTO blocked(handle, blocked_at) VALUES ('+821012345678', 1)`;
          return fromPartial<Session.Info>({ id: Session.ID.make("ses_blocked") });
        }),
      sessions: {
        remove: () =>
          Effect.sync(() => {
            removed++;
          }),
      },
    });
    const directory = yield* conversations;
    const worker = yield* firstContacts(
      host,
      { textStatus: () => Effect.succeed("unknown") },
      directory,
      "test/probe",
    );
    yield* sql`UPDATE discovery_contact SET scheduled_at = 0`;
    yield* worker.tick;
    return { created, removed };
  });
