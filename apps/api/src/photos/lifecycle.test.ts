import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect, test, vi } from "vitest";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";
import { conversationPhotos } from "./photos.ts";
import { fixture, input } from "./photos.test-helper.ts";
import { hour } from "./store.ts";
import { photoKey } from "./storage.ts";

test("self continuity uses the most recently sent self in this Conversation within six hours", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.photos.take(f.conversation, input, "first");
      if (first.status !== "taken") throw new Error("Expected photo");
      yield* f.sql`INSERT INTO send(handle,conversation_id,kind,content,state,recorded_at,updated_at)
    VALUES(${f.conversation.handle},${f.conversation.id},'photo',${first.photo},'sent',0,0)`;
      expect(yield* f.photos.sendable(f.conversation, first.photo)).toBeUndefined();
      yield* f.photos.take(f.conversation, input, "second");
      expect(
        yield* Effect.promise(() => new Request(...f.fetcher.mock.calls.at(-1)!).json()),
      ).toHaveProperty("image", [
        `data:image/jpeg;base64,${first.data}`,
        `data:image/jpeg;base64,${first.data}`,
      ]);
      yield* f.photos.take(f.other, input, "other");
      expect(
        yield* Effect.promise(() => new Request(...f.fetcher.mock.calls.at(-1)!).json()),
      ).toHaveProperty("image", [`data:image/jpeg;base64,${first.data}`]);
      yield* TestClock.adjust(6 * hour);
      yield* f.photos.take(f.conversation, input, "later");
      expect(
        yield* Effect.promise(() => new Request(...f.fetcher.mock.calls.at(-1)!).json()),
      ).toHaveProperty("image", [`data:image/jpeg;base64,${first.data}`]);
      yield* f.photos.cleanup();
      expect(f.objects.has(photoKey(first.photo))).toBe(true);
      expect(yield* f.photos.nextCleanup()).toBe(7 * hour);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("expiry preserves uncertain admission, cancelled sends keep the photo, and removal queues durable deletion", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.photos.take(f.conversation, input, "first");
      if (first.status !== "taken") throw new Error("Expected photo");
      yield* f.sql`INSERT INTO send(handle,conversation_id,kind,content,state,recorded_at,updated_at)
    VALUES(${f.conversation.handle},${f.conversation.id},'photo',${first.photo},'not_sent',0,0)`;
      expect(yield* f.photos.sendable(f.conversation, first.photo)).toBe(first.data);
      yield* f.sql`UPDATE send SET state = 'uncertain'`;
      expect(yield* f.photos.sendable(f.conversation, first.photo)).toBeUndefined();
      yield* TestClock.adjust(hour);
      yield* f.photos.cleanup();
      expect(f.objects.size).toBe(1);
      expect(yield* f.photos.nextCleanup()).toBe(hour + 60_000);
      yield* f.sql`UPDATE send SET state = 'not_sent'`;
      yield* TestClock.adjust(60_000);
      yield* f.photos.cleanup();
      expect(f.objects.size).toBe(0);
      const second = yield* f.photos.take(f.other, input, "other");
      expect(second.status).toBe("taken");
      yield* f.sql`DELETE FROM send`;
      yield* f.sql`DELETE FROM user`;
      expect(yield* f.sql`SELECT * FROM conversation_photo`).toEqual([]);
      expect(yield* f.photos.nextCleanup()).toBe(0);
      const replacement = yield* conversationPhotos(f.options);
      yield* replacement.cleanup();
      expect(f.objects.size).toBe(0);
      expect(yield* replacement.nextCleanup()).toBeUndefined();
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("cleanup is bounded, retries failed R2 deletion after actor replacement, and repeated idle checks are write-free", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      for (let index = 0; index < 70; index++)
        yield* f.sql`INSERT INTO photo_object VALUES(${`orphan-${index}`}, 0)`;
      vi.mocked(f.bucket.delete).mockRejectedValueOnce(new Error("private storage payload"));
      expect(yield* f.photos.cleanup().pipe(Effect.flip)).toBeInstanceOf(Error);
      expect(yield* f.sql`SELECT COUNT(*) AS count FROM photo_object`).toEqual([{ count: 70 }]);
      const replacement = yield* conversationPhotos(f.options);
      expect(yield* replacement.cleanup()).toBe(50);
      expect(yield* replacement.cleanup()).toBe(20);
      const before = yield* f.sql`SELECT total_changes() AS n`;
      expect(yield* replacement.cleanup()).toBe(0);
      expect(yield* replacement.nextCleanup()).toBeUndefined();
      expect(yield* f.sql`SELECT total_changes() AS n`).toEqual(before);
      expect(
        JSON.stringify(
          yield* f.sql`EXPLAIN QUERY PLAN SELECT photo_id FROM photo_object
    WHERE due IS NOT NULL AND due <= 0 ORDER BY due, photo_id LIMIT 50`,
        ),
      ).toContain("photo_cleanup");
      expect(
        JSON.stringify(
          yield* f.sql`EXPLAIN QUERY PLAN SELECT 1 FROM conversation_photo
    WHERE conversation_id = 1 AND state = 'taken' AND taken_at > 0 LIMIT 3`,
        ),
      ).toContain("photo_limit");
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("missing stored bytes, invalid JPEG and oversized JPEG decline without consuming successful takes", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE conversation SET image_style = 'photo'`;
      const oversized = new Uint8Array(10_000_001).fill(0xff);
      oversized[1] = 0xd8;
      oversized[oversized.length - 1] = 0xd9;
      const invalid = [
        new Uint8Array([1, 2, 3]),
        new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        new Uint8Array([0xff, 0xd8, 0xff, 0, 0xd9]),
        new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0]),
        oversized,
      ];
      for (const [index, bytes] of invalid.entries()) {
        f.fetcher.mockResolvedValueOnce(
          Response.json({ data: [{ b64_json: Buffer.from(bytes).toString("base64") }] }),
        );
        expect(yield* f.photos.take(f.conversation, input, `invalid-${index}`)).toEqual({
          status: "declined",
        });
      }
      const photo = yield* f.photos.take(f.conversation, input, "valid");
      if (photo.status !== "taken") throw new Error("Expected photo");
      expect((yield* f.photos.take(f.conversation, input, "valid-second")).status).toBe("taken");
      expect((yield* f.photos.take(f.conversation, input, "valid-third")).status).toBe("taken");
      f.objects.clear();
      expect(yield* f.photos.take(f.conversation, input, "valid")).toEqual({ status: "declined" });
      expect(yield* f.photos.sendable(f.conversation, photo.photo)).toBeUndefined();
      expect(yield* f.photos.sendable(f.conversation, "nonexistent")).toBeUndefined();
      yield* f.photos.remove(f.conversation.id);
      expect(yield* f.sql`SELECT * FROM conversation_photo`).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));
