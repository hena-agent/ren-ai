import { rm } from "node:fs/promises";
import {
  messagingFixture,
  quietTestHost,
  runMessagingTest,
} from "../../test/messaging-host.test-helper.ts";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Session } from "@opencode/schema/session";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { conversations } from "./conversations.ts";
import { migrate } from "../database.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { intake } from "../intake/intake.ts";
import { rebuilder } from "./rebuild-session.ts";
import { noticeCopy } from "../onboarding/onboarding.ts";

const persona = {
  id: "persona1",
  timeZone: "Asia/Seoul",
  language: "ko",
  openingLine: "Hello",
  memory: "remember",
  prompt: "Speak Korean",
};
const handle = "user@example.com";
const conversationInput = {
  handle,
  locale: "ko",
  consentVersion: "v1",
  consentLanguage: "ko",
  personaID: persona.id,
};

test("rebuilding through OpenCode replays the record once, fences blocked Users and rejects unknown Personas", async () => {
  const { root, personaDirectory } = await messagingFixture("rebuild-real-", "Hello");
  const fake = fakeMessages();
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const host = yield* quietTestHost(root, personaDirectory, fake.messages);
        const original = yield* host.createSession(persona.id);
        const conversation = yield* host.conversations.create({
          ...conversationInput,
          sessionID: original.id,
        });
        const [started] = yield* (yield* SqlClient.SqlClient)<{
          startedAt: number;
        }>`SELECT started_at AS startedAt FROM conversation WHERE id = ${conversation.id}`;
        yield* fake.text(handle, "before onboarding", started!.startedAt - 1);
        yield* fake.text(handle, "first", started!.startedAt + 1);
        yield* fake.outgoing(handle, "her manual send", started!.startedAt + 2);
        yield* fake.text(handle, "later", started!.startedAt + 3_600_003);
        expect(yield* host.operator.rebuild("stranger@example.com")).toBe("not_found");
        expect(yield* host.operator.rebuild(handle)).toBe("rebuilt");
        const rebuilt = (yield* host.conversations.byHandle(handle))!;
        expect(rebuilt.sessionID).not.toBe(original.id);
        expect(Option.isNone(yield* host.sessions.get(original.id).pipe(Effect.option))).toBe(true);
        yield* host.sessions
          .wait(Session.ID.make(rebuilt.sessionID))
          .pipe(Effect.timeout("20 seconds"));
        const transcript = JSON.stringify(
          yield* host.sessions.messages({ sessionID: Session.ID.make(rebuilt.sessionID) }),
        );
        expect(transcript).toContain("<conversation-started");
        expect(transcript).toContain("first");
        expect(transcript).toContain("her manual send");
        expect(transcript).toContain("later");
        expect(transcript).toContain("<gap>");
        expect(transcript).not.toContain("before onboarding");
        const recovery = yield* rebuilder(host.conversations, host, noticeCopy, host.intake.replay);
        expect(yield* recovery.rebuild(handle)).toBe("present");
        yield* host.sessions.remove(Session.ID.make(rebuilt.sessionID));
        yield* recovery.missing;
        expect((yield* host.conversations.byHandle(handle))?.sessionID).not.toBe(rebuilt.sessionID);
        yield* host.conversations.block(handle);
        expect(yield* host.operator.rebuild(handle)).toBe("not_found");
        expect(yield* host.conversations.bySession(rebuilt.sessionID)).toBeUndefined();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE conversation SET persona_id = 'missing' WHERE id = ${conversation.id}`;
        yield* sql`DELETE FROM blocked WHERE handle = ${handle}`;
        const error = yield* host.operator.rebuild(handle).pipe(Effect.flip);
        expect(String(error)).toContain("Unknown persona");
        yield* sql`UPDATE conversation SET rebuilding = 1 WHERE id = ${conversation.id}`;
        expect(String(yield* recovery.rebuild(handle).pipe(Effect.flip))).toContain(
          "Unknown persona",
        );
        yield* sql`UPDATE conversation SET persona_id = 'persona1', rebuilding = 0 WHERE id = ${conversation.id}`;
        yield* sql`CREATE TEMP TRIGGER cancel_replacement BEFORE UPDATE OF session_id ON conversation
          BEGIN SELECT RAISE(IGNORE); END`;
        expect(yield* host.operator.rebuild(handle)).toBe("not_found");
        yield* sql`DROP TRIGGER cancel_replacement`;
        yield* sql`CREATE TEMP TRIGGER remove_origin AFTER UPDATE OF session_id ON conversation
          BEGIN DELETE FROM user WHERE id = NEW.user_id; END`;
        expect(yield* host.operator.rebuild(handle)).toBe("not_found");
        expect(yield* host.conversations.byHandle(handle)).toBeUndefined();
        yield* Effect.promise(host.disposeOnboarding);
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

test("replay stops admitting rows when the User is blocked mid-replay", async () => {
  const fake = fakeMessages();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const directory = yield* conversations;
        const conversation = yield* directory.create({ ...conversationInput, sessionID: "new" });
        const now = Date.now() + 1;
        yield* fake.text(handle, "first", now);
        yield* fake.text(handle, "second", now + 1);
        const prompts: string[] = [];
        const incoming = yield* intake(
          fake.messages,
          directory.byHandle,
          (_session, _id, text) =>
            Effect.gen(function* () {
              prompts.push(text);
              yield* directory.block(handle);
            }),
          () => persona.timeZone,
          undefined,
          undefined,
          undefined,
          false,
        );
        yield* incoming.replay(conversation);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("first");
        yield* incoming.replay(conversation);
        expect(prompts).toHaveLength(1);
        const outbound = yield* directory.create({
          ...conversationInput,
          handle: "other@example.com",
          sessionID: "other",
        });
        yield* fake.outgoing(outbound.handle, "manual", Date.now() + 1);
        yield* incoming.replay(outbound);
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("<sent-by-you");
        const pending = yield* directory.create({
          ...conversationInput,
          handle: "pending@example.com",
          sessionID: "pending",
        });
        yield* fake.text(pending.handle, "queued", Date.now() + 1);
        expect(prompts).toHaveLength(2);
        yield* incoming.start;
        expect(prompts[2]).toContain("queued");
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    ),
  );
});

test("replay preserves a follow-up's wake until a newer iMessage row arrives", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fake = fakeMessages();
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const directory = yield* conversations;
        const conversation = yield* directory.create({ ...conversationInput, sessionID: "fresh" });
        const first = yield* fake.text(handle, "already delivered", Date.now() + 1);
        yield* sql`INSERT INTO follow_up (conversation_id, last_sent_at, next_wake_at, unanswered)
          VALUES (${conversation.id}, ${first.createdAt}, 12345, 2)`;
        const received: number[] = [];
        const incoming = yield* intake(
          fake.messages,
          directory.byHandle,
          () => Effect.void,
          () => persona.timeZone,
          undefined,
          (_conversation, date) =>
            Effect.gen(function* () {
              received.push(date);
              yield* sql`UPDATE follow_up SET last_sent_at = ${date}, next_wake_at = 67890,
                unanswered = 0 WHERE conversation_id = ${conversation.id}`;
            }),
          undefined,
          false,
        );
        yield* incoming.replay(conversation);
        expect(received).toEqual([]);
        expect(yield* sql`SELECT next_wake_at, unanswered FROM follow_up`).toEqual([
          { next_wake_at: 12345, unanswered: 2 },
        ]);
        const newer = yield* fake.text(handle, "missed while offline", first.createdAt + 1);
        yield* incoming.replay(conversation);
        expect(received).toEqual([newer.createdAt]);
        expect(yield* sql`SELECT next_wake_at, unanswered FROM follow_up`).toEqual([
          { next_wake_at: 67890, unanswered: 0 },
        ]);
        yield* incoming.replay(conversation);
        expect(received).toEqual([newer.createdAt]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    ),
  );
});
