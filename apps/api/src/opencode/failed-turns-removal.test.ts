import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { expect, test, vi } from "vitest";
import { fakeMessages } from "@ren-ai/imsg/testing";
import { personaMemory, readRuntime } from "@ren-ai/plugin-session-folder/memory";
import {
  messagingFixture,
  registration,
  runMessagingTest,
} from "../../test/messaging.test-helper.ts";
import {
  providerUnavailable,
  scriptedPersona,
  startTestHost,
} from "../../test/messaging-host.test-helper.ts";
import { dueContact } from "../discovery/contact.test-helper.ts";
import type { PersonaRuntime } from "./runtime.ts";

test.each([true, false])(
  "removal erases private scopes and preserves life (accounting: %s)",
  async (accounting) => {
    const fixture = await messagingFixture("removal-without-accounting-");
    try {
      await runMessagingTest(
        Effect.gen(function* () {
          const host = yield* startTestHost(
            fixture.root,
            fixture.personaDirectory,
            yield* scriptedPersona(),
            fakeMessages().messages,
          );
          const key = "private-relationship";
          const session = yield* host.createSession("persona1", undefined, key);
          const relationship = yield* host.conversations.create({
            ...registration("missing-accounting@example.com", session.id),
            conversationKey: key,
          });
          const sibling = yield* host.createSession("persona1");
          yield* host.conversations.create(registration("sibling@example.com", sibling.id));
          const siblingPath = join(sibling.location.directory, "conversations", sibling.id);
          const siblingBefore = yield* Effect.promise(() => readRuntime(siblingPath));
          const memory = personaMemory(session.location.directory, session.id);
          yield* Effect.promise(() => memory.context());
          yield* Effect.promise(() =>
            memory.run(
              "update_memory",
              {
                scope: "life",
                markdown: "An unfinished painting",
                reason: "Own plans",
              },
              "own-plan",
              "own-plan",
            ),
          );
          const sql = yield* SqlClient.SqlClient;
          const replacement = accounting
            ? yield* host.createSession("persona1", undefined, key)
            : session;
          if (accounting) yield* host.conversations.replaceSession(relationship, replacement.id);
          const privatePath = join(session.location.directory, "conversations", key);
          expect((yield* Effect.promise(() => stat(privatePath))).isDirectory()).toBe(true);
          if (!accounting)
            yield* sql`DELETE FROM usage_session WHERE session_id = ${replacement.id}`;
          expect(yield* host.operator.remove(relationship.handle)).toBe("removed");
          expect(yield* host.operator.remove(relationship.handle)).toBe("not_found");
          yield* Effect.promise(() =>
            expect(stat(privatePath)).rejects.toMatchObject({ code: "ENOENT" }),
          );
          expect(yield* host.sessions.get(session.id).pipe(Effect.flip)).toBeInstanceOf(Error);
          expect(yield* host.sessions.get(replacement.id).pipe(Effect.flip)).toBeInstanceOf(Error);
          expect((yield* host.sessions.get(sibling.id)).id).toBe(sibling.id);
          expect(yield* Effect.promise(() => readRuntime(siblingPath))).toEqual(siblingBefore);
          const retained = accounting ? [session.id, sibling.id, replacement.id] : [sibling.id];
          expect(yield* sql`SELECT session_id FROM usage_session ORDER BY session_id`).toEqual(
            retained.toSorted().map((session_id) => ({ session_id })),
          );
          expect(yield* host.conversations.byHandle(relationship.handle)).toBeUndefined();
          expect(
            (yield* Effect.promise(() => readRuntime(session.location.directory)))?.shortTerm,
          ).toBe("An unfinished painting");
        }),
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test("operator removal retains a test session but forgets its durable failed-turn deadline", async () => {
  const { root, personaDirectory } = await messagingFixture("failed-retention-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const llm = yield* scriptedPersona();
        yield* llm.serve(() => providerUnavailable("Unavailable"));
        const host = yield* startTestHost(root, personaDirectory, llm, fakeMessages().messages);
        const session = yield* host.createSession("persona1");
        const handle = "retained@example.com";
        yield* host.operator.testHandle(handle, true);
        yield* host.conversations.create(registration(handle, session.id));
        yield* host.sessions.prompt({ sessionID: session.id, text: "failed before removal" });
        yield* host.sessions.wait(session.id);
        yield* host.heartbeat.failedTurns;
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT * FROM failed_turn`).toHaveLength(1);
        expect(yield* host.operator.remove(handle)).toBe("removed");
        expect(yield* sql`SELECT * FROM failed_turn`).toEqual([]);
        expect(yield* host.conversations.bySession(session.id)).toBeUndefined();
        expect((yield* host.sessions.get(session.id)).title).toContain("removed");
        const privatePath = join(session.location.directory, "conversations", session.id);
        expect((yield* Effect.promise(() => stat(privatePath))).isDirectory()).toBe(true);
        expect(yield* sql`SELECT session_id FROM usage_session`).toEqual([
          { session_id: session.id },
        ]);
        expect(yield* host.operator.remove(handle)).toBe("not_found");
        yield* TestClock.adjust("2 seconds");
        yield* host.heartbeat.failedTurns;
        expect(yield* llm.requests()).toHaveLength(1);
        // Retention carries its scope even if accounting is subsequently unavailable.
        yield* sql`DELETE FROM usage_session`;
        yield* host.operator.testHandle(handle, false);
        expect(yield* host.operator.remove(handle)).toBe("removed");
        yield* Effect.promise(() =>
          expect(stat(privatePath)).rejects.toMatchObject({ code: "ENOENT" }),
        );
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test.each([false, true])(
  "removal handles an unbound first-contact scope (test handle: %s)",
  async (keep) => {
    const { root, personaDirectory } = await messagingFixture("first-contact-removal-");
    try {
      await runMessagingTest(
        Effect.gen(function* () {
          const host = yield* startTestHost(
            root,
            personaDirectory,
            yield* scriptedPersona(),
            fakeMessages().messages,
          );
          const handle = "preparing@example.com";
          yield* dueContact(handle, "persona1");
          const session = yield* host.createSession("persona1");
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE discovery_contact SET session_id = ${session.id}, state = 'preparing'`;
          expect(yield* sql`SELECT * FROM usage_session`).toEqual([]);
          yield* host.operator.testHandle(handle, keep);
          expect(yield* host.operator.remove(handle)).toBe("removed");
          const privatePath = join(session.location.directory, "conversations", session.id);
          if (keep) {
            expect((yield* Effect.promise(() => stat(privatePath))).isDirectory()).toBe(true);
            yield* host.operator.testHandle(handle, false);
            expect(yield* host.operator.remove(handle)).toBe("removed");
          }
          yield* Effect.promise(() =>
            expect(stat(privatePath)).rejects.toMatchObject({ code: "ENOENT" }),
          );
          expect(yield* host.operator.remove(handle)).toBe("not_found");
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("scope erasure retries across actor replacement before and after native session deletion", async () => {
  const { root, personaDirectory } = await messagingFixture("removal-restart-");
  const applicationDatabase = join(root, "application.sqlite");
  const start = Effect.gen(function* () {
    return yield* startTestHost(
      root,
      personaDirectory,
      yield* scriptedPersona(),
      fakeMessages().messages,
      join(root, "native.sqlite"),
    );
  });
  const handle = "retry-removal@example.com";
  try {
    const original = await runMessagingTest(
      Effect.gen(function* () {
        const host = yield* start;
        const session = yield* host.createSession("persona1");
        yield* host.conversations.create(registration(handle, session.id));
        const runtime: PersonaRuntime = host;
        const remove = vi
          .spyOn(runtime.sessions, "remove")
          .mockReturnValueOnce(Effect.fail(new Error("native offline")));
        expect(yield* host.operator.remove(handle).pipe(Effect.flip)).toEqual(
          new Error("native offline"),
        );
        remove.mockRestore();
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT session_id FROM usage_session`).toEqual([
          { session_id: session.id },
        ]);
        expect(yield* sql`SELECT persona_id, conversation_key FROM removal`).toEqual([
          { persona_id: "persona1", conversation_key: session.id },
        ]);
        return {
          id: session.id,
          privatePath: join(session.location.directory, "conversations", session.id),
        };
      }),
      applicationDatabase,
    );
    await runMessagingTest(
      Effect.gen(function* () {
        const host = yield* start;
        const remove = vi
          .spyOn(host.sessions, "removeRelationship")
          .mockReturnValueOnce(Effect.fail(new Error("folder offline")));
        expect(yield* host.operator.remove(handle).pipe(Effect.flip)).toEqual(
          new Error("folder offline"),
        );
        remove.mockRestore();
        expect(yield* host.sessions.get(original.id).pipe(Effect.flip)).toBeInstanceOf(Error);
        expect((yield* Effect.promise(() => stat(original.privatePath))).isDirectory()).toBe(true);
      }),
      applicationDatabase,
    );
    await runMessagingTest(
      Effect.gen(function* () {
        const host = yield* start;
        expect(yield* host.operator.remove(handle)).toBe("removed");
        expect(yield* host.operator.remove(handle)).toBe("not_found");
        yield* Effect.promise(() =>
          expect(stat(original.privatePath)).rejects.toMatchObject({ code: "ENOENT" }),
        );
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT * FROM removal`).toEqual([]);
        // A marker for an already absent, unbound session has no Relationship scope to delete.
        yield* sql`INSERT INTO removal(handle, session_id) VALUES (${handle}, 'ses_already_absent')`;
        expect(yield* host.operator.remove(handle)).toBe("removed");
      }),
      applicationDatabase,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
