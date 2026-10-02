import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { applicationRpcFixture } from "../../test/application-rpc.test-helper.ts";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";

test("wait flushes readiness, emits empty heartbeats every twenty seconds, and completes with its result", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const fixture = yield* applicationRpcFixture;
        const response = yield* Effect.promise(() =>
          fixture.request("wait", { sessionID: "session", minutes: 1 }),
        );
        const reader: ReadableStreamDefaultReader<Uint8Array> = response.body!.getReader();
        yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel()));
        const ready = yield* Effect.promise(() => reader.read());
        expect(new TextDecoder().decode(ready.value)).toBe(
          '{"_tag":"Chunk","requestId":0,"values":[""]}\n',
        );
        for (let interval = 0; interval < 2; interval++) {
          let arrived = false;
          const heartbeat = reader.read().then((value) => {
            arrived = true;
            return value;
          });
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(19_999));
          expect(arrived).toBe(false);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
          expect(new TextDecoder().decode((yield* Effect.promise(() => heartbeat)).value)).toBe(
            '{"_tag":"Chunk","requestId":0,"values":[""]}\n',
          );
        }
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(20_000));
        let ending = "";
        for (;;) {
          const chunk = yield* Effect.promise(() => reader.read());
          if (chunk.done) break;
          ending += new TextDecoder().decode(chunk.value);
        }
        expect(ending).toContain('"paused 1m"');
        expect(ending).toContain('"_tag":"Success"');
      }),
    );
  } finally {
    vi.useRealTimers();
  }
});
