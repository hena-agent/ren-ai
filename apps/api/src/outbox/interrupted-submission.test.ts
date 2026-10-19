import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { fakeGestures, fakeMessages } from "@ren-ai/imsg/testing";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { outbox } from "./outbox.ts";

test("a send lost before gateway admission cannot permanently block the next bubble", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const conversation = yield* (yield* conversations).create({
          handle: "lost@example.test",
          sessionID: "lost",
          personaID: "persona",
          locale: "ko",
          consentVersion: "v1",
          consentLanguage: "ko",
        });
        const fake = fakeMessages();
        const personas = new Map([["persona", { timeZone: "UTC" }]]);
        const interrupted = yield* outbox(
          {
            ...fake.messages,
            sendText: () => Effect.fail(new Error("request lost before gateway admission")),
          },
          fakeGestures().gestures,
          personas,
          undefined,
          undefined,
          { typing: false },
        );
        expect(yield* interrupted.send(conversation, "lost", "first")).toBe(
          "not sent: send in doubt",
        );
        const restarted = yield* outbox(
          fake.messages,
          fakeGestures().gestures,
          personas,
          undefined,
          undefined,
          { typing: false },
        );
        expect(yield* restarted.send(conversation, "next", "second")).toBe("sent");
        const sql = yield* SqlClient.SqlClient;
        const attempts = yield* sql<{
          content: string;
          attemptID: string;
        }>`SELECT content, attempt_id AS attemptID FROM send ORDER BY id`;
        // Delayed requests and retries cannot replay either the rejected or the accepted attempt.
        for (const row of attempts)
          yield* fake.messages.sendText(conversation.handle, row.content, row.attemptID);
        expect(fake.bubbles.map((row) => row.text)).toEqual(["next"]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    ),
  );
});
