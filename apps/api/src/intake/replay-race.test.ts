import { Deferred, Effect, Fiber } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { fakeMessages } from "@ren-ai/imsg/testing";
import { intake } from "./intake.ts";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";

test.each([false, true])(
  "replay and live intake can acknowledge the same message concurrently (outgoing: %s)",
  async (outgoing) => {
    await runMessagingTest(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const directory = yield* conversations;
        const conversation = yield* directory.create({
          handle: "test@example.com",
          locale: "ko",
          consentVersion: "v1",
          consentLanguage: "ko",
          personaID: "persona1",
          sessionID: "session1",
        });
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const ids: string[] = [];
        const fake = fakeMessages();
        const incoming = yield* intake(
          fake.messages,
          directory.byHandle,
          (_session, id) =>
            Effect.gen(function* () {
              ids.push(id);
              if (ids.length === 1) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(resume);
              }
            }),
          () => "Asia/Seoul",
          () => Effect.succeed(false),
        );
        const row = yield* (outgoing ? fake.outgoing : fake.text)(
          conversation.handle,
          "same message",
          Date.now() + 1,
        );
        const live = yield* Effect.forkScoped(incoming.poll);
        yield* Deferred.await(entered);
        yield* incoming.replay(conversation);
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(live);
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(1);
        expect(
          yield* sql`SELECT guid FROM intake_seen WHERE session_id = ${conversation.sessionID}`,
        ).toEqual([{ guid: row.guid }]);
        yield* incoming.poll;
        expect(ids).toHaveLength(2);
        expect(yield* sql`SELECT row_id FROM bookmark WHERE id = 1`).toEqual([{ row_id: row.id }]);
      }),
    );
  },
);
