import { Session } from "@opencode/schema";
import { Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, test } from "vitest";
import { remoteHost } from "./remote.ts";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";

test.each(
  ["headers", "body"].flatMap((stage) =>
    // session.wait is a no-content response; only its headers can stall a caller.
    (stage === "headers"
      ? ["session", "history", "folder", "wait"]
      : ["session", "history", "folder"]
    ).map((operation) => ({ stage, operation })),
  ),
)(
  "an OpenCode $operation request with stalled $stage is cancelled within its deadline",
  async ({ stage, operation }) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const signals: AbortSignal[] = [];
          let bodyCancelled = false;
          const remote = yield* remoteHost(
            {
              baseUrl: "https://oc.test",
              authorization: "Bearer private-token",
              directory: "/private/conversations",
              model: "test/probe",
              groundRules: "",
            },
            new Map(),
          ).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
              const request = new Request(input, init);
              signals.push(request.signal);
              Effect.runSync(Deferred.succeed(entered, undefined));
              if (stage === "headers")
                return new Promise<Response>((_resolve, reject) => {
                  request.signal.addEventListener("abort", () => reject(request.signal.reason), {
                    once: true,
                  });
                });
              return Promise.resolve(
                new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      request.signal.addEventListener(
                        "abort",
                        () => {
                          bodyCancelled = true;
                          controller.error(request.signal.reason);
                        },
                        { once: true },
                      );
                    },
                  }),
                  { headers: { "Content-Type": "application/json" } },
                ),
              );
            }),
          );
          const sessionID = Session.ID.make("ses_stalled");
          const request =
            operation === "session"
              ? remote.sessions.get(sessionID).pipe(Effect.asVoid)
              : operation === "history"
                ? remote.client.message.list({ sessionID }).pipe(Effect.asVoid)
                : operation === "folder"
                  ? remote.client
                      .rpc(sessionFolders)
                      .read(
                        { folderID: sessionID },
                        {
                          location: { directory: "/private/conversations" },
                        },
                      )
                      .pipe(Effect.asVoid)
                  : remote.sessions.wait(sessionID);
          const call = yield* request.pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* TestClock.adjust("61 seconds");
          const result = call.pollUnsafe();
          expect(result).toBeDefined();
          if (result) expect(Exit.isFailure(result)).toBe(true);
          expect(signals).toHaveLength(1);
          expect(signals[0]!.aborted).toBe(true);
          if (stage === "body") expect(bodyCancelled).toBe(true);
        }).pipe(Effect.provide(TestClock.layer())),
      ),
    );
  },
);

test("an established OpenCode event stream outlives request deadlines and closes on interruption", () =>
  withRemoteHost((native, directory, { transport }) =>
    Effect.gen(function* () {
      const connected = yield* Deferred.make<void>();
      const signals: AbortSignal[] = [];
      const remote = yield* remoteHost(
        {
          baseUrl: "https://oc.test",
          authorization: "Basic test",
          directory,
          model: "test/probe",
          groundRules: "",
        },
        native.personas,
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
          const request = new Request(input, init);
          signals.push(request.signal);
          return transport.fetch(request);
        }),
      );
      const observing = yield* remote.outcomes.pipe(
        Stream.runForEach(() => Deferred.succeed(connected, undefined)),
        Effect.forkScoped,
      );
      yield* Deferred.await(connected);
      yield* TestClock.adjust("2 minutes");
      expect(observing.pollUnsafe()).toBeUndefined();
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(false);
      yield* Fiber.interrupt(observing);
    }).pipe(Effect.provide(TestClock.layer())),
  ));
