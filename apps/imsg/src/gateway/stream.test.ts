import { expect, test, vi } from "vitest";
import { Deferred, Effect } from "effect";
import { gatewayFixture } from "../../test/gateway.test-helper.ts";
import { fixture as imsgFixture } from "../messages/imsg.fake.ts";
import { makeImsgMessages } from "../messages/imsg.ts";

test("an idle HTTP stream flushes readiness immediately and heartbeats every twenty seconds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const fixture = gatewayFixture();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fixture.request("follow", { rowID: 0, date: null });
    expect(response.body).not.toBeNull();
    reader = response.body!.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toBe(
      '{"_tag":"Chunk","requestId":0,"values":[null]}\n',
    );
    for (let interval = 0; interval < 2; interval++) {
      let arrived = false;
      const heartbeat = reader.read().then((value) => {
        arrived = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(19_999);
      expect(arrived).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(new TextDecoder().decode((await heartbeat).value)).toBe(
        '{"_tag":"Chunk","requestId":0,"values":[null]}\n',
      );
    }
  } finally {
    await reader?.cancel();
    await fixture.server.dispose();
    vi.useRealTimers();
  }
});

test("stopping the client stream prevents further deliveries while the client scope stays alive", async () => {
  const fixture = gatewayFixture();
  try {
    await fixture.run((remote) =>
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        const seen: string[] = [];
        const stop = yield* remote.follow(0, (row) =>
          Effect.gen(function* () {
            seen.push(row.text);
            yield* Deferred.succeed(first, undefined);
          }),
        );
        yield* fixture.local.text("handle", "before stop", 100);
        yield* Deferred.await(first).pipe(Effect.timeout("2 seconds"));
        stop();
        yield* Effect.sleep("20 millis");
        yield* fixture.local.text("handle", "after stop", 101);
        yield* Effect.sleep("20 millis");
        expect(seen).toEqual(["before stop"]);
      }),
    );
  } finally {
    await fixture.server.dispose();
  }
});

test("canceling HTTP follow stops the native imsg watch instead of leaving background history probes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const imsg = imsgFixture();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const messages = yield* makeImsgMessages({
            raise: () => Effect.void,
            clear: () => Effect.void,
          });
          const fixture = gatewayFixture(messages);
          yield* Effect.addFinalizer(() => Effect.promise(fixture.server.dispose));
          const response = yield* Effect.promise(() =>
            fixture.request("follow", { rowID: 10, date: null }),
          );
          const reader = response.body!.getReader();
          yield* Effect.promise(() => reader.read());
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(imsg.commands.some((command) => command.method === "watch.subscribe")).toBe(
                true,
              ),
            ),
          );
          yield* Effect.promise(() => reader.cancel());
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(100));
          const before = imsg.commands.filter(
            (command) => command.method === "messages.after",
          ).length;
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(30_000));
          expect(
            imsg.commands.filter((command) => command.method === "messages.after"),
          ).toHaveLength(before);
        }),
      ).pipe(Effect.provide(imsg.dependencies)),
    );
  } finally {
    vi.useRealTimers();
  }
});
