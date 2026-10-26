import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, test, vi } from "vitest";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";
import { conversationPhotos } from "./photos.ts";
import { bytes, fixture, input } from "./photos.test-helper.ts";
import { generationTimeout, hour, photoStore } from "./store.ts";
import { photoKey } from "./storage.ts";

test("a two-minute timeout aborts the request, releases capacity and retains the failed call receipt", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = Deferred.makeUnsafe<void>();
      let aborted = false;
      f.fetcher.mockImplementation((_url, init) => {
        Deferred.doneUnsafe(entered, Effect.void);
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }),
        );
      });
      const fiber = yield* f.photos.take(f.conversation, input, "timeout").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(generationTimeout);
      expect(yield* Fiber.join(fiber)).toEqual({ status: "declined" });
      expect(aborted).toBe(true);
      expect(yield* f.photos.take(f.conversation, input, "timeout")).toEqual({
        status: "declined",
      });
      const replacement = yield* photoStore(f.bucket);
      expect(yield* replacement.reserve(f.conversation, "next", "new", false)).toBe(true);
      yield* TestClock.adjust(generationTimeout);
      expect(yield* replacement.finish(f.conversation, "new")).toBeUndefined();
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("off switch during sheet lookup prevents dispatch; missing persona and malformed sheet privately decline", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const missing = yield* conversationPhotos({ ...f.options, personas: new Map() });
      expect(yield* missing.take(f.conversation, input, "persona")).toEqual({ status: "declined" });
      const malformed = yield* conversationPhotos({
        ...f.options,
        sheet: async () => ({ bytes: new Uint8Array(), mimeType: "image/png" }),
      });
      expect(yield* malformed.take(f.conversation, input, "malformed")).toEqual({
        status: "declined",
      });
      const switched = yield* conversationPhotos({
        ...f.options,
        sheet: async () => {
          await Effect.runPromise(f.photos.setEnabled(false));
          return { bytes, mimeType: "image/jpeg" };
        },
      });
      expect(yield* switched.take(f.conversation, input, "off")).toEqual({ status: "declined" });
      yield* switched.setEnabled(true);
      // A separate active callback models removal after the initial lookup while the sheet is loaded.
      const active = vi
        .fn<typeof f.options.active>()
        .mockReturnValueOnce(Effect.succeed(true))
        .mockReturnValue(Effect.succeed(false));
      const ended = yield* conversationPhotos({ ...f.options, active });
      expect(yield* ended.take(f.conversation, input, "ended")).toEqual({ status: "declined" });
      expect(f.fetcher).not.toHaveBeenCalled();
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("removal during R2 put keeps cleanup durable; a late result never resurrects deleted history", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = Deferred.makeUnsafe<void>();
      const gate = Deferred.makeUnsafe<void>();
      vi.mocked(f.bucket.put).mockImplementation(async (key, value) => {
        Deferred.doneUnsafe(entered, Effect.void);
        await Effect.runPromise(Deferred.await(gate));
        f.objects.set(key, value);
        return {};
      });
      const fiber = yield* f.photos.take(f.conversation, input, "removed").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* f.sql`DELETE FROM user`;
      expect(yield* f.photos.cleanup()).toBe(0);
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(fiber)).toEqual({ status: "declined" });
      expect(f.objects.size).toBe(1);
      yield* TestClock.adjust(hour);
      const replacement = yield* conversationPhotos(f.options);
      yield* replacement.cleanup();
      expect(f.objects.size).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("sent surroundings never become self references; stored images remain isolated when send state changes", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const photo = yield* f.photos.take(
        f.conversation,
        { ...input, includesMe: false },
        "surroundings",
      );
      if (photo.status !== "taken") throw new Error("Expected photo");
      yield* f.sql`INSERT INTO send(handle,conversation_id,kind,content,state,recorded_at,updated_at)
    VALUES(${f.conversation.handle},${f.conversation.id},'photo',${photo.photo},'delivered',0,0)`;
      const store = yield* photoStore(f.bucket);
      expect(yield* store.continuity(f.conversation)).toBeUndefined();
      yield* f.sql`UPDATE conversation_photo SET includes_me = 1`;
      expect(yield* store.continuity(f.conversation)).toBe(photo.data);
      f.objects.delete(photoKey(photo.photo));
      expect(yield* store.continuity(f.conversation)).toBeUndefined();
      yield* store.remove(f.conversation.id);
      yield* f.sql`DELETE FROM user`;
      expect(yield* store.style(f.conversation)).toBeUndefined();
      expect(yield* store.reserve(f.conversation, "missing", "missing", true)).toBe(false);
    }).pipe(Effect.provide(TestClock.layer())),
  ));
