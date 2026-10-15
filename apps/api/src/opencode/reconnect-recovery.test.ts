import { Effect, Result } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
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
        if (pending) expect(yield* app.sessions.inbox(session.id)).toHaveLength(1);
        else {
          yield* app.sessions.wait(session.id);
          expect((yield* app.sessions.get(session.id)).outcome).toBe("failed");
        }
        offline = true;
        expect(Result.isFailure(yield* Effect.result(app.heartbeat.failedTurns))).toBe(true);
        yield* llm.serve(() => TestLLM.text("after reconnect", "answer"));
        offline = false;
        if (failInventory) {
          injectInventoryFailure = true;
          inventoryFailures = 0;
          expect(Result.isFailure(yield* Effect.result(app.heartbeat.failedTurns))).toBe(true);
        }
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
