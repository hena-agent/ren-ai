import { Clock, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { remoteMessages } from "@ren-ai/imsg/client";
import { gatewayFixture } from "../../../imsg/test/gateway.test-helper.ts";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { captureDiagnostics } from "../../test/diagnostics.test-helper.ts";
import { applicationRpcFixture } from "../../test/application-rpc.test-helper.ts";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";

const fail = () =>
  Effect.fail(
    new Error("private text application-secret", {
      cause: Object.assign(new Error("private upstream"), { code: "ECONNRESET" }),
    }),
  );

test("submission and resolution failures preserve correlation, uncertainty and private-data exclusion through RPC", async () => {
  const { logs, restore } = captureDiagnostics();
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const f = yield* applicationRpcFixture;
        const requestId = crypto.randomUUID();
        f.transport.fetch = (request) => {
          request.headers.set("x-operation-id", requestId);
          return f.web.handler(request);
        };
        f.messages.messages.sendText = fail;
        f.messages.messages.resolveSend = fail;
        const send = (callID: string) =>
          f.client.send({ sessionID: f.conversation.sessionID, callID, text: "private text" });
        expect(yield* send("private-first")).toBe("not sent: send in doubt");
        expect(String(yield* send("private-second").pipe(Effect.flip))).toContain(requestId);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT state FROM send`).toEqual([{ state: "uncertain" }]);
        expect(f.messages.bubbles).toEqual([]);
        const failures = logs.filter((line) => line.includes('"outcome":"failed"'));
        expect(failures).toHaveLength(2);
        for (const stage of ["transport.submit", "transport.resolve"]) {
          const entry = failures.find((line) => line.includes(stage))!;
          expect(entry).toContain(requestId);
          expect(entry).toContain("ECONNRESET");
          expect(entry).toContain('"operationId":');
        }
        for (const sensitive of [
          f.conversation.handle,
          "private text",
          "private upstream",
          "application-secret",
          "private-first",
          "private-second",
        ])
          expect(logs.join("\n")).not.toContain(sensitive);
      }),
    );
  } finally {
    restore();
  }
});

test("a timed-out Mac submission stays uncertain, logs its cause once and never resends", async () => {
  const { logs, restore } = captureDiagnostics();
  const gateway = gatewayFixture();
  const entered = Deferred.makeUnsafe<void>();
  let attempts = 0;
  gateway.local.messages.sendText = () =>
    Effect.sync(() => {
      attempts++;
    }).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Effect.never));
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const f = yield* applicationRpcFixture;
        const remote = yield* remoteMessages({
          url: "https://imsg.test/rpc",
          token: "secret",
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
            gateway.transport.fetch(new Request(input, init)),
          ),
        );
        f.gestures.gestures.typing = () => Effect.succeed(true);
        const clock = yield* Clock.Clock;
        f.messages.messages.sendText = (handle, text, attemptID) =>
          remote.sendText(handle, text, attemptID).pipe(Effect.provideService(Clock.Clock, clock));
        f.messages.messages.resolveSend = () => Effect.succeed("unknown");
        const requestId = crypto.randomUUID();
        f.transport.fetch = (request) => {
          request.headers.set("x-operation-id", requestId);
          return f.web.handler(request);
        };
        const sending = yield* f.client
          .send({
            sessionID: f.conversation.sessionID,
            callID: "private-timeout",
            text: "private timeout text",
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("30 seconds");
        expect(yield* Fiber.join(sending)).toBe("not sent: send in doubt");
        expect(
          yield* f.client.send({
            sessionID: f.conversation.sessionID,
            callID: "private-next",
            text: "private next text",
          }),
        ).toBe("not sent: an earlier send is still in doubt");
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT state FROM send`).toEqual([{ state: "uncertain" }]);
        expect(attempts).toBe(1);
        const failures = logs.filter((line) => line.includes('"outcome":"failed"'));
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain(requestId);
        expect(failures[0]).toContain("transport.submit");
        expect(failures[0]).toContain("TimeoutError");
        expect(failures[0]).toContain('"operationId":');
        for (const sensitive of [
          f.conversation.handle,
          "private timeout text",
          "private-timeout",
          "secret",
        ])
          expect(logs.join("\n")).not.toContain(sensitive);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    await gateway.server.dispose();
    restore();
  }
});
