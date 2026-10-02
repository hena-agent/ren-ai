import { Deferred, Effect } from "effect";
import { expect, test } from "vitest";
import { servePublic } from "./public-listener.ts";
import { listenerUrl } from "../test/listener.test-helper.ts";

test("a disconnected HTTP caller aborts its pending application request", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const aborted = yield* Deferred.make<void>();
        const server = yield* servePublic(
          (request) =>
            new Promise<Response>((resolve) => {
              request.signal.addEventListener(
                "abort",
                () => {
                  Effect.runSync(Deferred.succeed(aborted, undefined));
                  resolve(new Response(null, { status: 499 }));
                },
                { once: true },
              );
              Effect.runSync(Deferred.succeed(started, undefined));
            }),
          0,
        );
        const controller = new AbortController();
        const response = fetch(listenerUrl(server), { signal: controller.signal }).catch(
          () => "aborted",
        );
        yield* Deferred.await(started).pipe(Effect.timeout("2 seconds"));
        controller.abort();
        yield* Deferred.await(aborted).pipe(Effect.timeout("2 seconds"));
        expect(yield* Effect.promise(() => response)).toBe("aborted");
      }),
    ),
  );
});
