import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";
import { bytes, fixture, input, hour } from "./photos.test-helper.ts";
import { photoStore } from "./store.ts";
import { photoKey } from "./storage.ts";

test("late status reconciliation cannot renew or reorder the six-hour self-photo reference", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      const store = yield* photoStore(f.bucket);
      const first = yield* f.photos.take(f.conversation, input, "first");
      if (first.status !== "taken") throw new Error("Expected photo");
      yield* f.sql`INSERT INTO send(handle,conversation_id,kind,content,state,recorded_at,updated_at)
    VALUES(${f.conversation.handle},${f.conversation.id},'photo',${first.photo},'uncertain',0,0)`;
      yield* TestClock.adjust(hour);
      const second = yield* f.photos.take(f.conversation, input, "second");
      if (second.status !== "taken") throw new Error("Expected photo");
      const newer = new Uint8Array([...bytes.slice(0, -2), 0, 0xff, 0xd9]);
      f.objects.set(photoKey(second.photo), newer);
      yield* f.sql`INSERT INTO send(handle,conversation_id,kind,content,state,recorded_at,updated_at)
    VALUES(${f.conversation.handle},${f.conversation.id},'photo',${second.photo},'sent',${hour},${hour})`;
      yield* TestClock.adjust(hour);
      yield* f.sql`UPDATE send SET state = 'delivered', updated_at = ${2 * hour} WHERE content = ${first.photo}`;
      expect(yield* store.continuity(f.conversation)).toBe(Buffer.from(newer).toString("base64"));
      yield* TestClock.adjust(5 * hour);
      yield* f.sql`UPDATE send SET updated_at = ${7 * hour}`;
      expect(yield* store.continuity(f.conversation)).toBeUndefined();
      expect(
        JSON.stringify(
          yield* f.sql`EXPLAIN QUERY PLAN SELECT p.id FROM send s JOIN conversation_photo p
    ON p.id = s.content AND p.conversation_id = s.conversation_id
    WHERE s.conversation_id = 1 AND s.kind = 'photo' AND s.state IN ('sent','delivered')
      AND s.recorded_at > 0 AND p.includes_me = 1 AND p.state = 'taken'
    ORDER BY s.recorded_at DESC LIMIT 1`,
        ),
      ).toContain("send_photo_history");
    }).pipe(Effect.provide(TestClock.layer())),
  ));
