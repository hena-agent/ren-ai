import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Random, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { HttpClientError } from "effect/unstable/http";
import { OpenApi } from "effect/unstable/httpapi";
import { expect, test } from "vitest";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { intake } from "../intake/intake.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { outbox } from "../outbox/outbox.ts";
import { operatorApi, operatorHandler } from "./api.ts";
import { runOperatorCli } from "./cli.ts";
import { makeOperator } from "./operator.ts";
import { operatorClient, serveOperatorSocket } from "./socket.ts";

const input = {
  handle: "user@example.com",
  locale: "ko",
  consentVersion: "v1",
  consentLanguage: "ko",
  personaID: "persona1",
  sessionID: "session-1",
};

test("blocking silences Intake, Outbox and session lookup but preserves User rows", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const directory = yield* conversations;
        const fake = fakeMessages();
        const conversation = yield* directory.create(input);
        const sql = yield* SqlClient.SqlClient;
        const gestures = fakeGestures();
        const sends = yield* outbox(fake.messages, gestures.gestures, new Map(), directory.active);
        const prompts: string[] = [];
        yield* intake(
          fake.messages,
          directory.byHandle,
          (_session, _id, text) =>
            Effect.sync(() => {
              prompts.push(text);
            }),
          () => "Asia/Seoul",
        );
        yield* directory.block(input.handle);
        yield* directory.block(input.handle);
        expect(yield* directory.byHandle(input.handle)).toBeUndefined();
        expect(yield* directory.bySession(input.sessionID)).toBeUndefined();
        expect(yield* directory.active(conversation)).toBe(false);
        yield* fake.text(input.handle, "ignored", 1234);
        expect(prompts).toEqual([]);
        expect(yield* sends.send(conversation, "never", "call-1")).toBe(
          "not sent: this Conversation is unavailable",
        );
        expect(yield* sends.react(conversation, "like", "call-2")).toBe(
          "not reacted: this Conversation is unavailable",
        );
        yield* sends.notice(input.handle, "blocked notice");
        expect(gestures.typing).toEqual([]);
        expect(gestures.reactions).toEqual([]);
        expect(fake.bubbles).toEqual([]);
        expect((yield* sql`SELECT id FROM user`).length).toBe(1);
        expect((yield* sql`SELECT handle FROM blocked`).length).toBe(1);
        expect((yield* sql`SELECT id FROM send`).length).toBe(0);
        const late = yield* directory.create({
          ...input,
          handle: "late@example.com",
          sessionID: "late",
        });
        const duringTyping = yield* outbox(
          fake.messages,
          {
            ...gestures.gestures,
            typing: () => directory.block(late.handle).pipe(Effect.as(true)),
          },
          new Map(),
          directory.active,
        );
        expect(yield* duringTyping.send(late, "no", "call-2")).toBe(
          "not sent: this Conversation is unavailable",
        );
        const reacting = yield* directory.create({
          ...input,
          handle: "reacting@example.com",
          sessionID: "reacting",
        });
        const target = yield* fake.text(reacting.handle, "hello", 1235);
        const duringRead = yield* outbox(
          {
            ...fake.messages,
            after: (id) =>
              fake.messages.after(id).pipe(Effect.tap(() => directory.block(reacting.handle))),
          },
          gestures.gestures,
          new Map(),
          directory.active,
        );
        expect(yield* duringRead.react(reacting, "love", "call-3", target.guid)).toBe(
          "not reacted: this Conversation is unavailable",
        );
        expect(gestures.reactions).toEqual([]);
        expect(fake.bubbles).toEqual([]);
      }).pipe(
        Random.withSeed("operator"),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  );
});

test("removal of a pending Notice also deletes its User without a session", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at)
        VALUES (${input.handle}, 'ko', 'v1', 'ko', 1)`;
      yield* sql`INSERT INTO send (handle, kind, content, state, recorded_at, updated_at)
        VALUES (${input.handle}, 'notice', 'private', 'recorded', 1, 1)`;
      const directory = yield* conversations;
      const removed: string[] = [];
      const operator = yield* makeOperator(directory, (sessionID) =>
        Effect.sync(() => {
          removed.push(sessionID);
        }),
      );
      expect(yield* operator.rebuild(input.handle)).toBe("not_found");
      expect(yield* operator.remove(input.handle)).toBe("removed");
      expect(removed).toEqual([]);
      expect(yield* sql`SELECT * FROM user`).toEqual([]);
      expect(yield* sql`SELECT * FROM send`).toEqual([]);
      expect(yield* operator.remove(input.handle)).toBe("not_found");
      const freePages = yield* sql<{ freelist_count: number }>`PRAGMA freelist_count`;
      expect(freePages[0]?.freelist_count).toBe(0);
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );
});

test("removal deletes all User data atomically, keeps a retry marker on failure and vacuums on success", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const directory = yield* conversations;
      const conversation = yield* directory.create(input);
      yield* sql`INSERT INTO send (handle, kind, content, state, recorded_at, updated_at)
      VALUES (${input.handle}, 'notice', 'private', 'sent', 1, 1)`;
      yield* sql`INSERT INTO intake_seen (session_id, guid) VALUES (${input.sessionID}, 'guid')`;
      yield* sql`INSERT INTO intake_last (conversation_id, date) VALUES (${conversation.id}, 1)`;
      yield* directory.block(input.handle);
      let attempts = 0;
      const removed: string[] = [];
      const operator = yield* makeOperator(directory, (sessionID) =>
        Effect.gen(function* () {
          attempts++;
          if (attempts === 1) return yield* Effect.fail(new Error("OpenCode unavailable"));
          removed.push(sessionID);
          return undefined;
        }),
      );
      expect(Result.isFailure(yield* Effect.result(operator.remove(input.handle)))).toBe(true);
      for (const table of [
        "user",
        "conversation",
        "send",
        "intake_seen",
        "intake_last",
        "blocked",
      ]) {
        expect((yield* sql`SELECT * FROM ${sql(table)}`).length).toBe(0);
      }
      expect(yield* sql`SELECT session_id FROM removal`).toEqual([{ session_id: input.sessionID }]);
      expect(yield* operator.remove(input.handle)).toBe("removed");
      expect(removed).toEqual([input.sessionID]);
      expect(yield* operator.remove(input.handle)).toBe("not_found");
      expect((yield* sql`SELECT * FROM removal`).length).toBe(0);
      expect((yield* sql`PRAGMA freelist_count`)[0]).toEqual({ freelist_count: 0 });
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );
});

test("the operator HTTP API documents its typed request, result and error contract", () => {
  const spec = OpenApi.fromApi(operatorApi);
  const contract = JSON.stringify(spec.paths);
  expect(operatorApi.identifier).toBe("operator");
  expect(spec.paths).toHaveProperty("/remove");
  expect(spec.paths).toHaveProperty("/block");
  expect(spec.paths).toHaveProperty("/rebuild");
  expect(JSON.stringify(spec.paths["/remove"])).toContain('"required":["result"]');
  const rebuild = JSON.stringify(spec.paths["/rebuild"]);
  expect(rebuild).toContain('"required":["result"]');
  expect(rebuild).toContain('"present"');
  for (const field of ["handle", "reason", "result", "blocked"]) {
    expect(contract).toContain(`"required":["${field}"]`);
  }
});

test("the rebuild route handles an unavailable operation", async () => {
  const api = operatorHandler({
    block: () => Effect.void,
    remove: () => Effect.succeed("not_found"),
  });
  try {
    const answer = await api.handler(
      new Request("http://operator/rebuild", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: input.handle }),
      }),
    );
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ result: "not_found" });
  } finally {
    await api.dispose();
  }
});

test("HTTP API, typed CLI and owner-only Unix socket run together", async () => {
  const root = await mkdtemp(join(tmpdir(), "operator-"));
  const path = join(root, "state", "operator.sock");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* migrate;
          const directory = yield* conversations;
          yield* directory.create(input);
          const removed: string[] = [];
          let attempts = 0;
          const operations = yield* makeOperator(
            directory,
            (sessionID) =>
              Effect.gen(function* () {
                attempts++;
                if (attempts === 1)
                  return yield* Effect.fail(new Error("OpenCode temporarily unavailable"));
                removed.push(sessionID);
                return undefined;
              }),
            (handle) =>
              Effect.succeed(
                handle === input.handle ? ("rebuilt" as const) : ("not_found" as const),
              ),
          );
          const { handler, dispose } = operatorHandler(operations);
          yield* Effect.addFinalizer(() => Effect.promise(dispose));
          const stop = yield* Effect.promise(() =>
            serveOperatorSocket(path, async (request) => {
              expect(request.headers.get("content-type")).toContain("application/json");
              const response = await handler(request);
              response.headers.set("x-operator", "local-only");
              return response;
            }),
          );
          yield* Effect.addFinalizer(() => Effect.promise(stop));
          expect((yield* Effect.promise(() => stat(path))).mode & 0o777).toBe(0o600);
          expect((yield* Effect.promise(() => stat(join(root, "state")))).mode & 0o777).toBe(0o700);
          const client = yield* operatorClient(path);
          const [answer, wire] = yield* client.operator.block({
            payload: { handle: " USER@EXAMPLE.COM " },
            responseMode: "decoded-and-response",
          });
          expect(answer).toEqual({ blocked: true });
          expect(yield* runOperatorCli(["rebuild", "USER@EXAMPLE.COM"], path)).toBe(
            "Rebuilt USER@EXAMPLE.COM",
          );
          expect(yield* runOperatorCli(["rebuild", "other@example.com"], path)).toBe(
            "No User for other@example.com",
          );
          expect(wire.headers["x-operator"]).toBe("local-only");
          expect(yield* directory.byHandle(input.handle)).toBeUndefined();
          expect(yield* runOperatorCli(["remove", "USER@EXAMPLE.COM"], path)).toBe(
            "Removed USER@EXAMPLE.COM",
          );
          expect(removed).toEqual([input.sessionID]);
          expect(attempts).toBe(2);
          expect(yield* runOperatorCli(["remove", input.handle], path)).toBe(
            `No User for ${input.handle}`,
          );
          for (const args of [
            [],
            ["remove"],
            ["other", input.handle],
            ["block", ""],
            ["remove", input.handle, "extra"],
          ]) {
            expect(yield* runOperatorCli(args, path).pipe(Effect.flip)).toEqual(
              new Error("Usage: operator remove|block|rebuild HANDLE"),
            );
          }
          expect(yield* runOperatorCli(["block", "other@example.com"], path)).toBe(
            "Blocked other@example.com",
          );
          const invalid = yield* client.operator
            .block({ payload: { handle: "bad" } })
            .pipe(Effect.flip);
          expect(invalid).toEqual({ reason: "Error: Invalid Handle" });
          const rawInvalid = yield* client.operator.block({
            payload: { handle: "bad" },
            responseMode: "response-only",
          });
          expect(rawInvalid.status).toBe(503);
          let failedCalls = 0;
          const failed = operatorHandler({
            block: () => Effect.fail(new Error("database offline")),
            remove: () =>
              Effect.gen(function* () {
                failedCalls++;
                return yield* Effect.fail(new Error("OpenCode offline"));
              }),
            rebuild: () => Effect.fail(new Error("rebuild offline")),
          });
          const rebuildFailure = yield* Effect.promise(() =>
            failed.handler(
              new Request("http://operator/rebuild", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ handle: input.handle }),
              }),
            ),
          );
          expect(rebuildFailure.status).toBe(503);
          expect(yield* Effect.promise(() => rebuildFailure.json())).toEqual({
            reason: "Error: rebuild offline",
          });
          const failedResponse = yield* Effect.promise(() =>
            failed.handler(
              new Request("http://operator/block", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ handle: input.handle }),
              }),
            ),
          );
          expect(failedResponse.status).toBe(503);
          expect(yield* Effect.promise(() => failedResponse.json())).toEqual({
            reason: "Error: database offline",
          });
          const failureSocket = join(root, "state", "failed.sock");
          const stopFailures = yield* Effect.promise(() =>
            serveOperatorSocket(failureSocket, failed.handler),
          );
          expect(
            Result.isFailure(
              yield* Effect.result(runOperatorCli(["remove", input.handle], failureSocket)),
            ),
          ).toBe(true);
          expect(failedCalls).toBe(3);
          const failureClient = yield* operatorClient(failureSocket);
          expect(
            (yield* failureClient.operator.remove({
              payload: { handle: input.handle },
              responseMode: "response-only",
            })).status,
          ).toBe(503);
          yield* Effect.promise(stopFailures);
          yield* Effect.promise(failed.dispose);
          const connectionFailure = yield* operatorClient(join(root, "missing.sock")).pipe(
            Effect.flatMap((missing) =>
              missing.operator.block({ payload: { handle: input.handle } }),
            ),
            Effect.flip,
          );
          expect(connectionFailure).toBeInstanceOf(HttpClientError.HttpClientError);
          if (!HttpClientError.isHttpClientError(connectionFailure))
            throw new Error("Not a transport error");
          expect(connectionFailure.reason).toBeInstanceOf(HttpClientError.TransportError);
          expect(connectionFailure.request.url).toBe("http://operator/block");
        }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the socket translates HTTP failures and refuses a second listener on the same path", async () => {
  const root = await mkdtemp(join(tmpdir(), "operator-failure-"));
  const path = join(root, "state", "operator.sock");
  try {
    const close = await serveOperatorSocket(path, async () => {
      throw new Error("handler failed");
    });
    try {
      await expect(
        serveOperatorSocket(path, async () => new Response("unreachable")),
      ).rejects.toThrow("EADDRINUSE");
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest({ socketPath: path, path: "/", method: "GET" }, (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        });
        request.on("error", reject);
        request.end();
      });
      expect(status).toBe(500);
    } finally {
      await close();
      await expect(close()).rejects.toThrow("Server is not running");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
