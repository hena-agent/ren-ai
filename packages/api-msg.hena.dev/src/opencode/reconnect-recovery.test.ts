import { Deferred, Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";
import { registration, providerUnavailable } from "../../test/messaging-host.test-helper.ts";
import { startMessagingApplication } from "../application.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { noticeCopy } from "../onboarding/onboarding.ts";

test.each([
  { failInventory: false, pending: false },
  { failInventory: true, pending: false },
  { failInventory: false, pending: true },
])(
  "reconnecting recovers durable work ($failInventory inventory failure, $pending pending)",
  ({ failInventory, pending }) =>
    withRemoteHost((remote, _directory, { llm, transport }) =>
      Effect.gen(function* () {
        const forward = transport.fetch;
        let offline = true;
        let inventoryFailures = 0;
        transport.fetch = (request) => {
          const path = new URL(request.url).pathname;
          if (offline && path === "/api/event")
            return Promise.resolve(new Response("event connection unavailable", { status: 503 }));
          if (
            !offline &&
            failInventory &&
            inventoryFailures === 0 &&
            /^\/api\/session\/[^/]+$/.test(path)
          ) {
            inventoryFailures++;
            return Promise.resolve(
              new Response("inventory temporarily unavailable", { status: 503 }),
            );
          }
          return forward(request);
        };
        const lost = yield* Deferred.make<void>();
        const reconciled = yield* Deferred.make<void>();
        const alerts: string[] = [];
        const health = {
          raise: (name: string, detail?: string) =>
            Effect.gen(function* () {
              alerts.push(`raise:${name}`);
              if (name === "opencode-events") {
                expect(detail).toBe("OpenCode event stream or reconciliation failed");
                yield* Deferred.succeed(lost, undefined);
              }
            }),
          clear: (name: string) =>
            Effect.gen(function* () {
              alerts.push(`clear:${name}`);
              if (name === "opencode-events") yield* Deferred.succeed(reconciled, undefined);
            }),
        };
        const messages = fakeMessages();
        const app = yield* startMessagingApplication(
          remote.personas,
          () => Effect.succeed(remote),
          messages.messages,
          fakeGestures().gestures,
          { turnstileSecret: "test", notice: noticeCopy },
          health,
        );
        yield* Effect.addFinalizer(() => Effect.promise(app.disposeOnboarding));
        yield* Deferred.await(lost).pipe(Effect.timeout("2 seconds"));
        const session = yield* app.createSession("persona1");
        yield* app.conversations.create(registration("restart@example.com", session.id));
        yield* llm.serve(() => providerUnavailable("offline model"));
        if (pending) {
          yield* app.sessions.prompt({
            sessionID: session.id,
            text: "recover this",
            resume: false,
          });
          expect(yield* app.sessions.inbox(session.id)).toHaveLength(1);
        } else {
          yield* messages.text("restart@example.com", "recover this", Date.now());
          yield* app.sessions.wait(session.id);
          expect((yield* app.sessions.get(session.id)).outcome).toBe("failed");
        }
        yield* llm.serve(() => TestLLM.text("after reconnect", "answer"));
        offline = false;
        yield* Deferred.await(reconciled).pipe(Effect.timeout("5 seconds"));
        yield* Effect.gen(function* () {
          while ((yield* app.sessions.get(session.id)).outcome !== "succeeded")
            yield* Effect.sleep("10 millis");
        }).pipe(Effect.timeout("5 seconds"));
        expect(JSON.stringify(yield* app.sessions.messages({ sessionID: session.id }))).toContain(
          "after reconnect",
        );
        expect(alerts).toContain("clear:opencode-events");
        expect(inventoryFailures).toBe(failInventory ? 1 : 0);
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    ),
);
