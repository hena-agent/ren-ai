import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Deferred, Effect, Fiber, type Scope } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, expect, test, vi } from "vitest";
import { fakeGestures } from "@ren-ai/imsg/testing";
import { type Messages } from "@ren-ai/imsg";
import { cleanup, incoming, rustpushFixture } from "../../../imsg/test/bridge.test-helper.ts";
import { gatewayFixture } from "../../../imsg/test/gateway.test-helper.ts";
import { conversations, type Conversation } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { outbox } from "./outbox.ts";
import { photo, takenPhoto } from "./photo.test-helper.ts";

afterEach(cleanup);
const personas = new Map([["persona", { timeZone: "UTC" }]]);
const blockedPhoto = () => Effect.die("a fenced send must not load image bytes");
const loadPhoto = () => Effect.succeed(photo);
const box = (messages: Messages) =>
  outbox(messages, fakeGestures().gestures, personas, undefined, undefined, { typing: false });
const fixture = () => {
  const f = rustpushFixture(undefined, 10);
  const run = <A, E>(
    story: (
      messages: Messages,
      conversation: Conversation,
    ) => Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
  ) =>
    f.run((adapter) =>
      Effect.promise(async () => {
        const gateway = gatewayFixture(adapter.messages);
        try {
          return await gateway.run((remote) =>
            Effect.gen(function* () {
              yield* migrate;
              const directory = yield* conversations;
              const conversation =
                (yield* directory.bySession("restart")) ??
                (yield* directory.create({
                  handle: "recovery@example.test",
                  sessionID: "restart",
                  personaID: "persona",
                  locale: "ko",
                  consentVersion: "v1",
                  consentLanguage: "ko",
                }));
              return yield* story(remote, conversation);
            }).pipe(
              Effect.provide(SqliteClient.layer({ filename: join(f.directory, "app.sqlite") })),
            ),
          );
        } finally {
          await gateway.server.dispose();
        }
      }),
    );
  return { ...f, run };
};

test("interruption before admission recovers across both restarts and fences late HTTP submissions", async () => {
  const f = fixture();
  const id = await f.run((remote, conversation) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const sends = yield* box({
        ...remote,
        sendText: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const sending = yield* sends
        .send(conversation, "lost text", "lost-call")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(sending);
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{
        attemptID: string;
        state: string;
      }>`SELECT attempt_id AS attemptID, state FROM send`;
      expect(row!.state).toBe("recorded");
      expect(row!.attemptID).toMatch(/^[0-9A-F-]{36}$/);
      return row!.attemptID;
    }),
  );
  await f.run((remote, conversation) =>
    Effect.gen(function* () {
      const sends = yield* box(remote);
      expect(yield* sends.send(conversation, "next text", "next-call")).toBe("sent");
      expect((yield* sends.results("restart"))[0]).toMatchObject({
        state: "failed",
        toolCallID: "lost-call",
      });
      yield* remote.sendText(conversation.handle, "lost text", id);
      expect(yield* remote.resolveSend(id)).toBe("failed");
      expect((yield* remote.recent(conversation.handle, 0)).map((row) => row.text)).toEqual([
        "next text",
      ]);
    }),
  );
  await f.run((remote, conversation) =>
    Effect.gen(function* () {
      yield* remote.sendText(conversation.handle, "lost text", id.toLowerCase());
      expect(yield* remote.resolveSend(id)).toBe("failed");
      const [sent] = yield* remote.recent(conversation.handle, 0);
      yield* remote.sendText(conversation.handle, sent!.text, sent!.guid);
      expect(yield* remote.resolveSend(sent!.guid)).toBe("sent");
      expect(
        (yield* remote
          .sendText(conversation.handle, "conflicting text", sent!.guid)
          .pipe(Effect.flip)).message,
      ).toContain("request");
    }),
  );
  expect(f.bridge.requests.filter((request) => request.method === "send")).toHaveLength(1);
});

test("an accepted send with a lost acknowledgement is observed by identity without replay", async () => {
  const f = fixture();
  await f.run((remote, conversation) =>
    Effect.gen(function* () {
      const lost = yield* box({
        ...remote,
        sendText: (handle, text, id) =>
          remote
            .sendText(handle, text, id)
            .pipe(Effect.andThen(Effect.fail(new Error("lost acknowledgement")))),
      });
      expect(yield* lost.send(conversation, "already sent", "accepted")).toBe(
        "not sent: send in doubt",
      );
    }),
  );
  await f.run((remote, conversation) =>
    Effect.gen(function* () {
      const sends = yield* box(remote);
      expect(yield* sends.send(conversation, "next", "next")).toContain(
        'earlier message "already sent" did go out',
      );
      expect(yield* sends.release(conversation, "accepted", "failed")).toBe("settled");
      expect(yield* sends.send(conversation, "next", "distinct-call")).toBe("sent");
    }),
  );
  expect(f.bridge.requests.filter((request) => request.method === "send")).toHaveLength(2);
});

test("an admitted but unconfirmed send remains fenced through restart until a receipt arrives", async () => {
  const f = fixture();
  f.bridge.answer("send", { stage: "send", cause: { code: "unconfirmed" } });
  const id = await f.run((remote, conversation) =>
    Effect.gen(function* () {
      const sends = yield* box(remote);
      expect(yield* sends.send(conversation, "pending", "pending-call")).toBe(
        "not sent: send in doubt",
      );
      return (yield* remote.recent(conversation.handle, 0))[0]!.guid;
    }),
  );
  await f.run((remote, conversation) =>
    Effect.gen(function* () {
      const sends = yield* box(remote);
      expect(yield* sends.send(conversation, "next", "next-call")).toBe(
        "not sent: an earlier send is still in doubt",
      );
      expect(yield* sends.release(conversation, "pending-call", "failed")).toBe("uncertain");
      yield* remote.sendText(conversation.handle, "pending", id);
      f.bridge.deliver({
        ...incoming(`mailto:${conversation.handle}`, "", Date.now()),
        kind: "delivered",
        guid: id,
      });
      yield* Effect.promise(() =>
        vi.waitFor(async () =>
          expect(await Effect.runPromise(remote.resolveSend(id))).toBe("delivered"),
        ),
      );
      expect(yield* sends.release(conversation, "pending-call", "failed")).toBe("settled");
      expect((yield* sends.results("restart"))[0]?.state).toBe("delivered");
    }),
  );
  expect(f.bridge.requests.filter((request) => request.method === "send")).toHaveLength(1);
});

test("photo attempts survive interrupted submission and restart with the same transport fences", async () => {
  const f = fixture();
  const interruptedID = await f.run((remote, conversation) =>
    Effect.gen(function* () {
      for (const id of ["interrupted-photo", "uncertain-photo", "next-photo"])
        yield* takenPhoto(conversation, id);
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* box({
        ...remote,
        sendPhoto: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const fiber = yield* interrupted
        .sendPhoto(conversation, "interrupted-photo", "interrupted", loadPhoto)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{
        attemptID: string;
        state: string;
        content: string;
      }>`SELECT attempt_id AS attemptID, state, content FROM send`;
      expect(row).toMatchObject({ state: "recorded", content: "interrupted-photo" });
      return row!.attemptID;
    }),
  );
  f.bridge.answer("send_image", { stage: "send", cause: { code: "unconfirmed" } });
  const uncertainID = await f.run((remote, conversation) =>
    Effect.gen(function* () {
      const sends = yield* box(remote);
      // Recovery fences the interrupted attempt before admitting this next photo.
      expect(
        yield* sends.sendPhoto(conversation, "uncertain-photo", "uncertain", loadPhoto),
      ).toContain("send in doubt");
      yield* remote.sendPhoto(conversation.handle, photo, interruptedID);
      expect(yield* remote.resolveSend(interruptedID)).toBe("failed");
      const [row] = yield* remote.recent(conversation.handle, 0);
      expect(row!.attachments).toHaveLength(1);
      return row!.guid;
    }),
  );
  await f.run((remote, conversation) =>
    Effect.gen(function* () {
      const sends = yield* box(remote);
      expect(yield* sends.sendPhoto(conversation, "next-photo", "next", blockedPhoto)).toContain(
        "earlier send is still in doubt",
      );
      expect(yield* sends.send(conversation, "text also waits", "text-next")).toContain(
        "earlier send is still in doubt",
      );
      expect(yield* sends.release(conversation, "uncertain", "failed")).toBe("uncertain");
      f.bridge.deliver({
        ...incoming(`mailto:${conversation.handle}`, "", Date.now()),
        kind: "delivered",
        guid: uncertainID,
      });
      yield* Effect.promise(() =>
        vi.waitFor(async () =>
          expect(await Effect.runPromise(remote.resolveSend(uncertainID))).toBe("delivered"),
        ),
      );
      expect(yield* sends.sendPhoto(conversation, "next-photo", "next", blockedPhoto)).toContain(
        'earlier photo "uncertain-photo" did go out',
      );
      expect(
        (yield* sends.results(conversation.sessionID)).map((row) => [row.content, row.state]),
      ).toEqual([
        ["interrupted-photo", "failed"],
        ["uncertain-photo", "delivered"],
      ]);
      yield* remote.sendPhoto(conversation.handle, photo, uncertainID);
      expect(yield* remote.recent(conversation.handle, 0)).toHaveLength(1);
    }),
  );
  expect(f.bridge.requests.filter((request) => request.method === "send_image")).toHaveLength(1);
});
