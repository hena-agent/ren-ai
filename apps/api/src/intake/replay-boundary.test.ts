import { Effect } from "effect";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SqlClient } from "effect/unstable/sql";
import { fakeMessages } from "@ren-ai/imsg/testing";
import type { Messages } from "@ren-ai/imsg";
import { expect, test } from "vitest";
import { migrate } from "../database.ts";
import { conversations, type Conversation } from "../conversations/conversations.ts";
import {
  messagingFixture,
  registration,
  runMessagingTest,
} from "../../test/messaging.test-helper.ts";
import { intake } from "./intake.ts";

const recordingIntake = (messages: Messages, directory: Effect.Success<typeof conversations>) =>
  Effect.gen(function* () {
    const prompts: string[] = [];
    const callbacks: number[] = [];
    const prompt = (_session: string, _id: string, text: string) =>
      Effect.sync(() => {
        prompts.push(text);
      });
    const notify = (_conversation: Conversation, date: number) =>
      Effect.sync(() => {
        callbacks.push(date);
      });
    const incoming = yield* intake(
      messages,
      directory.byHandle,
      prompt,
      () => "UTC",
      undefined,
      notify,
      undefined,
      false,
      notify,
      undefined,
      undefined,
      directory.admitLive,
      prompt,
    );
    return { incoming, prompts, callbacks };
  });

test("late send ownership excludes a previous relationship despite a stale admission receipt", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const directory = yield* conversations;
      const source = yield* directory.create(
        registration("late-ownership@example.com", "current-source"),
      );
      yield* sql`INSERT INTO conversation (id, user_id, persona_id, session_id, started_at, ended_at, usage_key)
        SELECT 0, user_id, 'previous-persona', 'previous-session', 0, 1, 'previous-relationship'
        FROM conversation WHERE id = ${source.id}`;
      const fake = fakeMessages();
      const old = yield* fake.outgoing(
        source.handle,
        "private previous relationship",
        Date.now() + 1,
      );
      yield* sql`INSERT INTO intake_seen VALUES (${source.sessionID}, ${old.guid})`;
      // Late delivery reconciliation identifies the owner after the old admission receipt.
      yield* sql`INSERT INTO send (handle, conversation_id, kind, content, state, guid, recorded_at, updated_at)
        VALUES (${source.handle}, 0, 'text', ${old.text}, 'sent', ${old.guid}, 0, ${old.createdAt})`;
      yield* directory.replaceSession(source, "replacement");
      const current = (yield* directory.byHandle(source.handle))!;
      const { incoming, prompts, callbacks } = yield* recordingIntake(fake.messages, directory);
      yield* incoming.replay(current);
      expect(prompts).toEqual([]);
      expect(callbacks).toEqual([]);
      expect(
        yield* sql`SELECT guid FROM intake_seen WHERE session_id = ${current.sessionID}`,
      ).toEqual([]);
    }),
  ));

test("missing source admission receipts cannot turn unread Messages history into readonly replay", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const directory = yield* conversations;
      const sql = yield* SqlClient.SqlClient;
      const source = yield* directory.create(
        registration("missing-source@example.com", "missing-source"),
      );
      const fake = fakeMessages();
      const { incoming, prompts, callbacks } = yield* recordingIntake(fake.messages, directory);
      const unread = yield* fake.text(
        source.handle,
        "never admitted to the missing source",
        Date.now() + 1,
      );
      yield* directory.replaceSession(source, "recovered");
      const current = (yield* directory.byHandle(source.handle))!;
      yield* incoming.replay(current);
      expect(prompts).toEqual([]);
      expect(callbacks).toEqual([]);
      expect(yield* sql`SELECT guid FROM intake_seen WHERE guid = ${unread.guid}`).toEqual([]);
      yield* directory.rebuilt(current);
      yield* incoming.poll;
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(unread.text);
      expect(callbacks).toHaveLength(1);
    }),
  ));

test("a reopened database resumes historical progress and delivers unread input only after rebuild", async () => {
  const fixture = await messagingFixture("replay-restart-");
  const database = join(fixture.root, "application.sqlite");
  const fake = fakeMessages();
  const handle = "restart@example.com";
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const directory = yield* conversations;
        const source = yield* directory.create(registration(handle, "source"));
        const first = yield* fake.text(handle, "first history", Date.now() + 10);
        const second = yield* fake.text(handle, "second history", first.createdAt + 1);
        for (const row of [first, second])
          yield* sql`INSERT INTO intake_seen VALUES (${source.sessionID}, ${row.guid})`;
        yield* directory.replaceSession(source, "recovering");
        let prompts = 0;
        const incoming = yield* intake(
          fake.messages,
          directory.byHandle,
          () => (++prompts === 1 ? Effect.void : Effect.fail(new Error("Interrupted replay"))),
          () => "UTC",
          undefined,
          undefined,
          undefined,
          false,
        );
        expect(
          (yield* incoming.replay({ ...source, sessionID: "recovering" }).pipe(Effect.flip))
            .message,
        ).toBe("Interrupted replay");
        expect(yield* sql`SELECT guid FROM intake_seen WHERE session_id = 'recovering'`).toEqual([
          { guid: first.guid },
        ]);
      }),
      database,
    );
    const history = await Effect.runPromise(fake.messages.after(0));
    await Effect.runPromise(
      fake.replace([
        ...history,
        { ...history[0]!, id: 3, guid: "unread-restart", text: "unread while offline" },
      ]),
    );
    await runMessagingTest(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const directory = yield* conversations;
        const current = (yield* directory.byHandle(handle))!;
        const { incoming, prompts, callbacks } = yield* recordingIntake(fake.messages, directory);
        yield* incoming.replay(current);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("second history");
        expect(callbacks).toEqual([]);
        expect(yield* sql`SELECT guid FROM intake_seen WHERE guid = 'unread-restart'`).toEqual([]);
        yield* incoming.poll;
        expect(prompts).toHaveLength(1);
        expect(callbacks).toEqual([]);
        expect(yield* sql`SELECT guid FROM intake_seen WHERE guid = 'unread-restart'`).toEqual([]);
        expect(yield* sql`SELECT guid FROM intake_pending WHERE guid = 'unread-restart'`).toEqual([
          { guid: "unread-restart" },
        ]);
        yield* directory.rebuilt(current);
        yield* sql`UPDATE intake_pending SET retry_at = 0 WHERE guid = 'unread-restart'`;
        yield* incoming.poll;
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("unread while offline");
        expect(callbacks).toHaveLength(1);
        yield* incoming.poll;
        expect(prompts).toHaveLength(2);
        expect(
          yield* sql`SELECT session_id FROM intake_seen WHERE guid = 'unread-restart'`,
        ).toEqual([{ session_id: "recovering" }]);
      }),
      database,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "replay retains admitted source history across restart (superseded=%s), excluding unread arrivals",
  (superseded) =>
    runMessagingTest(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const directory = yield* conversations;
        const original = yield* directory.create(registration("replay@example.com", "source"));
        const fake = fakeMessages();
        const history = yield* fake.text(original.handle, "admitted history", Date.now() + 10);
        const sent = yield* fake.outgoing(original.handle, "original send", history.createdAt + 1);
        yield* sql`INSERT INTO intake_seen VALUES (${original.sessionID}, ${history.guid})`;
        yield* sql`INSERT INTO send (handle, conversation_id, kind, content, state, guid, recorded_at, updated_at)
      VALUES (${original.handle}, ${original.id}, 'text', ${sent.text}, 'sent', ${sent.guid}, ${sent.createdAt}, ${sent.createdAt})`;
        yield* directory.replaceSession(original, "replacement");
        if (superseded)
          yield* directory.replaceSession({ ...original, sessionID: "replacement" }, "superseding");
        // Even an old timestamp is not evidence this input was previously admitted.
        const live = yield* fake.text(original.handle, "unread live input", history.createdAt - 1);
        const { incoming, prompts, callbacks } = yield* recordingIntake(fake.messages, directory);
        const current = (yield* directory.byHandle(original.handle))!;
        yield* incoming.replay(current);
        expect(prompts.join("\n")).not.toContain(live.text);
        expect(prompts.join("\n")).toContain(history.text);
        expect(prompts.join("\n")).toContain(sent.text);
        expect(
          yield* sql`SELECT 1 FROM intake_seen WHERE session_id = ${current.sessionID} AND guid = ${live.guid}`,
        ).toEqual([]);
        expect(callbacks).toEqual([]);
        yield* incoming.replay(current);
        expect(prompts).toHaveLength(2);
      }),
    ),
);
