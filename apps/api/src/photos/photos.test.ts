import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";
import { conversationPhotos } from "./photos.ts";
import { bytes, fixture, input, hour } from "./photos.test-helper.ts";

test("takes are durable, isolated, deduplicated and limited across concurrent actors and rolling windows", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const second = yield* conversationPhotos(f.options);
      const results = yield* Effect.all(
        Array.from({ length: 12 }, (_, index) =>
          (index % 2 ? f.photos : second).take(f.conversation, input, `call-${index}`),
        ),
        { concurrency: "unbounded" },
      );
      const taken = results.filter((value) => value.status === "taken");
      expect(taken).toHaveLength(3);
      expect(f.fetcher).toHaveBeenCalledTimes(3);
      expect(yield* second.take(f.conversation, input, "call-0")).toEqual(results[0]);
      const first = taken[0]!;
      expect(yield* second.sendable(f.other, first.photo)).toBeUndefined();
      expect(yield* second.sendable(f.conversation, first.photo)).toBe(first.data);
      const request = new Request(...f.fetcher.mock.calls[0]!);
      expect(yield* Effect.promise(() => request.json())).toMatchObject({
        model: "gpt-image-2.5",
        size: "1152x1536",
        output_format: "jpeg",
        n: 1,
      });
      yield* TestClock.adjust(hour);
      expect(yield* second.take(f.conversation, input, "call-0")).toEqual({ status: "declined" });
      expect(yield* second.sendable(f.conversation, first.photo)).toBeUndefined();
      expect(yield* second.cleanup()).toBe(3);
      expect(f.objects.size).toBe(0);
      expect(yield* second.nextCleanup()).toBeUndefined();
      expect(yield* second.take(f.conversation, input, "limited")).toEqual({ status: "declined" });
      yield* TestClock.adjust(23 * hour);
      expect((yield* second.take(f.conversation, input, "new-day")).status).toBe("taken");
      expect(yield* second.take(f.conversation, input, "limited")).toEqual({ status: "declined" });
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("off switch persists, missing sheets decline surroundings too, failures do not count and logs exclude private data", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.photos.setEnabled(false);
      const replacement = yield* conversationPhotos(f.options);
      expect(yield* replacement.enabled()).toBe(false);
      expect(yield* replacement.take(f.conversation, input, "off")).toEqual({ status: "declined" });
      yield* replacement.setEnabled(true);
      const missing = yield* conversationPhotos({ ...f.options, sheet: async () => undefined });
      expect(yield* missing.take(f.conversation, { ...input, includesMe: false }, "sheet")).toEqual(
        { status: "declined" },
      );
      f.fetcher.mockResolvedValueOnce(
        Response.json(
          { error: { message: "private scene private key", code: "overloaded" } },
          { status: 503 },
        ),
      );
      expect(yield* replacement.take(f.conversation, input, "failed")).toEqual({
        status: "declined",
      });
      expect(yield* replacement.take(f.conversation, input, "failed")).toEqual({
        status: "declined",
      });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      const failed = f.log.mock.calls
        .map(([event]) => event)
        .find((event) => event.outcome === "failed");
      expect(failed).toMatchObject({
        stage: "generation",
        upstreamStatus: 503,
        code: "overloaded",
        personaId: "persona1",
        model: "gpt-image-2.5",
        style: "anime",
      });
      expect(failed?.requestId).toMatch(/^[a-f0-9-]{36}$/);
      for (const secret of [
        "private scene",
        "private key",
        "private description",
        "private handle",
        Buffer.from(bytes).toString("base64"),
      ])
        expect(JSON.stringify(f.log.mock.calls)).not.toContain(secret);
      expect(
        (yield* replacement.take(
          f.conversation,
          { ...input, includesMe: false, orientation: "landscape" },
          "surrounds",
        )).status,
      ).toBe("taken");
      const request = new Request(...f.fetcher.mock.calls.at(-1)!);
      expect(yield* Effect.promise(() => request.json())).toMatchObject({ size: "1536x1152" });
      expect(
        yield* Effect.promise(() => new Request(...f.fetcher.mock.calls.at(-1)!).json()),
      ).not.toHaveProperty("image");
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("pending calls reserve capacity, interruption aborts generation and cannot retry after replacement", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = Deferred.makeUnsafe<void>();
      let signal: AbortSignal | null | undefined;
      f.fetcher.mockImplementation((_url, init) => {
        signal = init?.signal;
        Deferred.doneUnsafe(entered, Effect.void);
        return new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("private aborted payload"))),
        );
      });
      const fiber = yield* f.photos
        .take(f.conversation, input, "interrupted")
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      expect(signal?.aborted).toBe(true);
      expect(f.log.mock.calls.some(([event]) => event.outcome === "failed")).toBe(true);
      const replacement = yield* conversationPhotos(f.options);
      expect(yield* replacement.take(f.conversation, input, "interrupted")).toEqual({
        status: "declined",
      });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(yield* f.sql`SELECT state FROM conversation_photo`).toEqual([{ state: "declined" }]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("active-session and operator fences reject results generated after a conversation changes", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = Deferred.makeUnsafe<void>();
      const gate = Deferred.makeUnsafe<Response>();
      f.fetcher.mockImplementation(() => {
        Deferred.doneUnsafe(entered, Effect.void);
        return Effect.runPromise(Deferred.await(gate));
      });
      const fiber = yield* f.photos.take(f.conversation, input, "racing").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* f.conv.replaceSession(f.conversation, "new-session");
      yield* Deferred.succeed(
        gate,
        Response.json({ data: [{ b64_json: Buffer.from(bytes).toString("base64") }] }),
      );
      expect(yield* Fiber.join(fiber)).toEqual({ status: "declined" });
      expect(f.bucket.put).not.toHaveBeenCalled();
      expect(yield* f.photos.take(f.conversation, input, "inactive")).toEqual({
        status: "declined",
      });
      expect(yield* f.photos.sendable(f.conversation, "missing")).toBeUndefined();
    }).pipe(Effect.provide(TestClock.layer())),
  ));
