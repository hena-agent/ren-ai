import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Clock, Deferred, Effect, Fiber, Random } from "effect";
import { TestClock } from "effect/testing";
import { outbox } from "./outbox.ts";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { fakeMessages } from "../messages/messages.fake.ts";

const registration = (handle: string, sessionID: string) => ({
  handle,
  sessionID,
  locale: "ko",
  consentVersion: "v1",
  consentLanguage: "ko",
  personaID: "persona1",
});
const personas = new Map([["persona1", { timeZone: "Asia/Seoul" }]]);

test("a recorded crash, confirmed late send, and Apple error 22 settle before the next bubble", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const directory = yield* conversations;
        const conversation = yield* directory.create(registration("crash@example.com", "s-crash"));
        const fake = fakeMessages();
        const sends = yield* outbox(fake.messages, fakeGestures().gestures, personas);
        expect(
          yield* sends.reconcile(conversation, {
            id: 10,
            guid: "other",
            text: "ignored",
            handle: conversation.handle,
            fromMe: false,
            createdAt: 0,
          }),
        ).toBe(false);
        expect(
          yield* sends.reconcile(conversation, {
            id: 11,
            guid: "other",
            text: "ignored",
            handle: "other@example.com",
            fromMe: true,
            createdAt: 0,
          }),
        ).toBe(false);
        expect(
          yield* sends.reconcile(conversation, {
            id: 12,
            guid: "other",
            text: "ignored",
            handle: conversation.handle,
            fromMe: true,
            createdAt: 0,
          }),
        ).toBe(false);
        yield* sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
      VALUES (${conversation.handle}, ${conversation.id}, 'text', 'lost', 'interrupted', 'recorded', 0, 0)`;
        const row = yield* fake.outgoing(conversation.handle, "lost", 0, "delivered");
        expect(yield* sends.send(conversation, "next", "next-call")).toBe(
          'not sent: your earlier message "lost" did go out at 09:00',
        );
        expect(fake.bubbles).toEqual([]);
        expect(yield* sends.send(conversation, "next", "next-call")).toBe(
          "not sent: this call was already recorded",
        );
        expect((yield* sends.results("s-crash"))[0]).toMatchObject({
          state: "delivered",
          toolCallID: "interrupted",
          late: 1,
        });
        expect(yield* sends.reconcile(conversation, row)).toBe(true);
        yield* fake.settle(row.guid, "failed");
        expect(yield* sends.reconcile(conversation, row)).toBe(true);
        expect((yield* sends.results("s-crash"))[0]?.state).toBe("delivered");
        expect(yield* sends.send(conversation, "new", "new-call")).toBe("sent");
        const sentRow = (yield* fake.messages.recent(conversation.handle, 0)).at(-1)!;
        yield* sql`UPDATE send SET state = 'recorded', late = 0, notification_pending = 0 WHERE tool_call_id = 'new-call'`;
        expect(yield* sends.reconcile(conversation, sentRow)).toBe(true);
        expect(
          (yield* sends.results("s-crash")).some((item) => item.toolCallID === "new-call"),
        ).toBe(true);
        yield* sql`UPDATE send SET notification_pending = 0 WHERE tool_call_id = 'new-call'`;
        yield* sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
      VALUES (${conversation.handle}, ${conversation.id}, 'text', 'rejected', 'failed-call', 'recorded', 0, 0)`;
        yield* fake.outgoing(conversation.handle, "rejected", 0, "failed");
        expect(yield* sends.send(conversation, "after failure", "after-call")).toBe("sent");
        expect((yield* sends.results("s-crash")).map((item) => item.state)).toEqual([
          "delivered",
          "sent",
          "failed",
        ]);
      }).pipe(
        Random.withSeed("crash"),
        Effect.provide(TestClock.layer()),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  );
});

test("a crash with no row or only unrelated rows fails safely after grace", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const directory = yield* conversations;
        const conversation = yield* directory.create(
          registration("unobserved@example.com", "unobserved"),
        );
        const fake = fakeMessages();
        const sends = yield* outbox(fake.messages, fakeGestures().gestures, personas);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
      VALUES (${conversation.handle}, ${conversation.id}, 'text', 'absent', 'crash', 'recorded', 0, 0)`;
        const stranger = yield* fake.outgoing("other@example.com", "absent", 0);
        expect(
          yield* sends.reconcile(conversation, {
            ...stranger,
            handle: conversation.handle,
            fromMe: false,
          }),
        ).toBe(false);
        expect(yield* sends.reconcile(conversation, stranger)).toBe(false);
        const wrong = yield* fake.outgoing(conversation.handle, "other text", 0);
        expect(yield* sends.reconcile(conversation, wrong)).toBe(false);
        yield* fake.text(conversation.handle, "absent", 0);
        const waiting = yield* Effect.forkScoped(
          sends.send(conversation, "proceed", "after-crash"),
        );
        yield* TestClock.adjust("3 seconds");
        expect(yield* Fiber.join(waiting)).toBe("sent");
        expect((yield* sends.results("unobserved"))[0]?.state).toBe("failed");
        yield* sql`UPDATE send SET state = 'uncertain', guid = 'expected-guid', late = 1,
          notification_pending = 1 WHERE tool_call_id = 'after-crash'`;
        yield* fake.outgoing(conversation.handle, "proceed", 3000, "sent", "different-guid");
        const another = yield* Effect.forkScoped(sends.send(conversation, "second", "second-call"));
        yield* TestClock.adjust("3 seconds");
        expect(yield* Fiber.join(another)).toBe("sent");
      }).pipe(
        Random.withSeed("unobserved"),
        Effect.provide(TestClock.layer()),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  );
});

test("unknown row status holds back the next send until Messages decides", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const directory = yield* conversations;
        const conversation = yield* directory.create(
          registration("pending@example.com", "pending"),
        );
        const sql = yield* SqlClient.SqlClient;
        const fake = fakeMessages();
        const sends = yield* outbox(fake.messages, fakeGestures().gestures, personas);
        yield* sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
      VALUES (${conversation.handle}, ${conversation.id}, 'text', 'maybe', 'maybe-call', 'recorded', 0, 0)`;
        const row = yield* fake.outgoing(conversation.handle, "maybe", 0, "unknown");
        const waiting = yield* Effect.forkScoped(sends.send(conversation, "later", "later-call"));
        yield* TestClock.adjust("3 seconds");
        expect(yield* Fiber.join(waiting)).toBe("not sent: an earlier send is still in doubt");
        expect(fake.bubbles).toEqual([]);
        yield* fake.settle(row.guid, "sent");
        expect(yield* sends.send(conversation, "later", "later-call")).toContain(
          'earlier message "maybe" did go out',
        );
      }).pipe(
        Random.withSeed("pending"),
        Effect.provide(TestClock.layer()),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  );
});

test("accepted RPC without a row remains in doubt; a failed status lookup cannot authorize a retry", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const directory = yield* conversations;
        const conversation = yield* directory.create(
          registration("ambiguous@example.com", "ambiguous"),
        );
        const fake = fakeMessages();
        const messages = {
          ...fake.messages,
          sendText: () => Effect.succeed({ guid: "uncertain-guid" }),
          sendStatus: () => Effect.fail(new Error("status unavailable")),
        };
        const sends = yield* outbox(messages, fakeGestures().gestures, personas);
        expect(yield* sends.send(conversation, "maybe", "one")).toBe("not sent: send in doubt");
        const row = yield* fake.outgoing(conversation.handle, "maybe", 0, "sent", "uncertain-guid");
        expect(yield* sends.reconcile(conversation, row)).toBe(true);
        const waiting = yield* Effect.forkScoped(sends.send(conversation, "next", "two"));
        yield* TestClock.adjust("3 seconds");
        expect(yield* Fiber.join(waiting)).toBe("not sent: an earlier send is still in doubt");
        const recovered = yield* outbox(fake.messages, fakeGestures().gestures, personas);
        expect(yield* recovered.send(conversation, "next", "two")).toContain(
          'earlier message "maybe" did go out',
        );
      }).pipe(
        Random.withSeed("ambiguous"),
        Effect.provide(TestClock.layer()),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  );
});

test("two concurrent calls in one Conversation cannot both pass the recorded-send check", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const directory = yield* conversations;
        const conversation = yield* directory.create(
          registration("parallel@example.com", "parallel"),
        );
        const fake = fakeMessages();
        const release = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        let typing = 0;
        const gestures = {
          ...fakeGestures().gestures,
          typing: () =>
            Effect.gen(function* () {
              typing++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return true;
            }),
        };
        const sends = yield* outbox(fake.messages, gestures, personas);
        const first = yield* Effect.forkScoped(sends.send(conversation, "first", "one"));
        yield* Deferred.await(entered);
        const second = yield* Effect.forkScoped(sends.send(conversation, "second", "two"));
        yield* Effect.sleep("50 millis");
        expect(typing).toBe(1);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(first)).toBe("sent");
        expect(yield* Fiber.join(second)).toBe("sent");
        expect(fake.bubbles.map((item) => item.text)).toEqual(["first", "second"]);
      }).pipe(
        Random.withSeed("parallel"),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  );
});

test("a restart reconciles a durable recorded attempt before allowing a new call", async () => {
  const root = await mkdtemp(join(tmpdir(), "outbox-restart-"));
  const file = join(root, "server.sqlite");
  const fake = fakeMessages();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* migrate;
          const conversation = yield* (yield* conversations).create(
            registration("restart@example.com", "restart"),
          );
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
        VALUES (${conversation.handle}, ${conversation.id}, 'text', 'first', 'interrupted-call', 'recorded', 0, 0)`;
        }).pipe(Effect.provide(SqliteClient.layer({ filename: file }))),
      ),
    );
    await Effect.runPromise(fake.outgoing("restart@example.com", "first", 0));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* migrate;
          const conversation = (yield* (yield* conversations).bySession("restart"))!;
          const sends = yield* outbox(fake.messages, fakeGestures().gestures, personas);
          expect(yield* sends.send(conversation, "second", "after-restart")).toContain(
            'earlier message "first" did go out',
          );
          expect(yield* sends.send(conversation, "second", "after-restart")).toBe(
            "not sent: this call was already recorded",
          );
          expect(fake.bubbles).toEqual([]);
        }).pipe(Effect.provide(SqliteClient.layer({ filename: file }))),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an uncertain tapback is reconciled before another send", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const conversation = yield* (yield* conversations).create(
          registration("react-late@example.com", "react-late"),
        );
        const fake = fakeMessages();
        const target = yield* fake.text(conversation.handle, "hello", 0);
        const sends = yield* outbox(
          fake.messages,
          {
            ...fakeGestures().gestures,
            react: () => Effect.fail(new Error("outcome unknown")),
          },
          personas,
        );
        expect(yield* sends.react(conversation, "like", "tap-1", target.guid)).toBe(
          "not reacted: send in doubt",
        );
        yield* fake.outgoing(
          conversation.handle,
          "like",
          yield* Clock.currentTimeMillis,
          "delivered",
        );
        expect(yield* sends.send(conversation, "next", "text-2")).toContain(
          'earlier tapback "like" did go out',
        );
        expect(fake.bubbles).toEqual([]);
        expect((yield* sends.results("react-late"))[0]).toMatchObject({
          state: "delivered",
          toolCallID: "tap-1",
        });
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    ),
  );
});
