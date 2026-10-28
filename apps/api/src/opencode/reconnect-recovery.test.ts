import { Effect, Result } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/sql";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";
import { registration, silentAlerts } from "../../test/messaging.test-helper.ts";
import { providerUnavailable } from "../../test/messaging-host.test-helper.ts";
import { startMessagingApplication } from "../application.ts";
import { fakeMessages, fakeGestures } from "@ren-ai/imsg/testing";

test.each([
  { failInventory: false, pending: false },
  { failInventory: true, pending: false },
  { failInventory: false, pending: true },
])(
  "finite reconciliation recovers durable work after reconnect ($failInventory inventory failure, $pending pending)",
  ({ failInventory, pending }) =>
    withRemoteHost((remote, _directory, { llm, transport }) =>
      Effect.gen(function* () {
        const forward = transport.fetch;
        let offline = false;
        let inventoryFailures = 0;
        let injectInventoryFailure = false;
        transport.fetch = (request) => {
          const path = new URL(request.url).pathname;
          if (/^\/api\/session\/[^/]+$/.test(path)) {
            if (offline)
              return Promise.resolve(
                new Response("inventory connection unavailable", { status: 503 }),
              );
            if (injectInventoryFailure && inventoryFailures === 0) {
              inventoryFailures++;
              return Promise.resolve(
                new Response("inventory temporarily unavailable", { status: 503 }),
              );
            }
          }
          return forward(request);
        };
        // First create the durable session and binding with the native transport available.
        const messages = fakeMessages();
        const app = yield* startMessagingApplication(
          remote.personas,
          () => Effect.succeed(remote),
          messages.messages,
          fakeGestures().gestures,
          silentAlerts,
        );
        const session = yield* remote.createSession("persona1");
        yield* app.conversations.create(registration("restart@example.com", session.id));
        yield* llm.serve(() => providerUnavailable("offline model"));
        yield* app.sessions.prompt({
          sessionID: session.id,
          text: "recover this",
          ...(pending && { resume: false }),
        });
        if (!pending) yield* app.sessions.wait(session.id);
        const initial = pending
          ? (yield* app.sessions.inbox(session.id)).length
          : (yield* app.sessions.get(session.id)).outcome;
        expect(initial).toBe(pending ? 1 : "failed");
        offline = true;
        expect(Result.isSuccess(yield* Effect.result(app.heartbeat.failedTurns))).toBe(true);
        const sql = yield* SqlClient.SqlClient;
        expect(
          yield* sql`SELECT attempts FROM application_work WHERE name = ${`turn:${session.id}`}`,
        ).toEqual([{ attempts: 1 }]);
        yield* sql`UPDATE application_work SET due = 0 WHERE name = ${`turn:${session.id}`}`;
        yield* llm.serve(() => TestLLM.text("after reconnect", "answer"));
        offline = false;
        if (failInventory) {
          injectInventoryFailure = true;
          inventoryFailures = 0;
          yield* app.heartbeat.failedTurns;
          yield* sql`UPDATE application_work SET due = 0 WHERE name = ${`turn:${session.id}`}`;
        }
        expect(inventoryFailures).toBe(failInventory ? 1 : 0);
        yield* Effect.gen(function* () {
          while ((yield* app.sessions.get(session.id)).outcome !== "succeeded") {
            yield* app.heartbeat.failedTurns;
            yield* Effect.sleep("20 millis");
          }
        }).pipe(Effect.timeout("5 seconds"));
        expect(JSON.stringify(yield* app.sessions.messages({ sessionID: session.id }))).toContain(
          "after reconnect",
        );
        expect(inventoryFailures).toBe(failInventory ? 1 : 0);
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    ),
);
