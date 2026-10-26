import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, test, vi } from "vitest";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";
import { conversationPhotos } from "./photos.ts";
import { bytes, fixture, input } from "./photos.test-helper.ts";
import { hour } from "./store.ts";

test("production fetch and JSON diagnostics exclude payloads and reject unsafe provider codes", async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      {
        error: {
          message: "private scene private key",
          code: "private scene",
        },
      },
      { status: 400 },
    ),
  );
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const photos = yield* conversationPhotos({
          personas: f.options.personas,
          key: f.options.key,
          sheet: f.options.sheet,
          active: f.options.active,
          bucket: f.bucket,
        });
        expect(yield* photos.take(f.conversation, input, "production")).toEqual({
          status: "declined",
        });
        expect(fetcher).toHaveBeenCalledOnce();
        const failures = stderr.mock.calls.map(([line]) => String(line)).join("");
        expect(failures).toContain('"code":"provider_error"');
        expect(failures).toContain('"upstreamStatus":400');
        for (const secret of [
          "private scene",
          "private key",
          "private description",
          "private handle",
        ])
          expect(failures).not.toContain(secret);
        expect(stdout.mock.calls.map(([line]) => String(line)).join("")).toContain(
          '"stage":"complete"',
        );
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    fetcher.mockRestore();
  }
});

test("an active-session change while loading bytes prevents exposing a sendable photo", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.photos.take(f.conversation, input, "taken");
      if (result.status !== "taken") throw new Error("Expected photo");
      const active = vi
        .fn<typeof f.options.active>()
        .mockReturnValueOnce(Effect.succeed(true))
        .mockReturnValue(Effect.succeed(false));
      const photos = yield* conversationPhotos({ ...f.options, active });
      expect(yield* photos.sendable(f.conversation, result.photo)).toBeUndefined();
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test.each(["send-expiry", "send-admission", "take-expiry", "take-inactive"] as const)(
  "%s fences a stored image loaded across an asynchronous boundary",
  (mode) =>
    runMessagingTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        const result = yield* f.photos.take(f.conversation, input, "taken");
        if (result.status !== "taken") throw new Error("Expected photo");
        if (mode.endsWith("expiry")) yield* TestClock.adjust(hour - 1000);
        const entered = Deferred.makeUnsafe<void>();
        const release = Deferred.makeUnsafe<void>();
        vi.mocked(f.bucket.get).mockImplementationOnce(async () => {
          Deferred.doneUnsafe(entered, Effect.void);
          await Effect.runPromise(Deferred.await(release));
          return { arrayBuffer: async () => Uint8Array.from(bytes).buffer };
        });
        const task = mode.startsWith("take")
          ? Effect.map(
              f.photos.take(f.conversation, input, "taken"),
              (value) => value.status === "declined",
            )
          : Effect.map(
              f.photos.sendable(f.conversation, result.photo),
              (value) => value === undefined,
            );
        const fiber = yield* task.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        if (mode.endsWith("expiry")) yield* TestClock.adjust(1000);
        else if (mode === "send-admission")
          yield* f.sql`INSERT INTO send(handle,conversation_id,kind,content,state,recorded_at,updated_at)
      VALUES(${f.conversation.handle},${f.conversation.id},'photo',${result.photo},'recorded',0,0)`;
        else yield* f.conv.replaceSession(f.conversation, "replacement");
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(fiber)).toBe(true);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
);
