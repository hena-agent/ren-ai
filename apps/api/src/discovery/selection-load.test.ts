import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { contacts } from "./contacts.ts";
import { contactFixture, withContactDatabase } from "./contact.test-helper.ts";

test("selection fetches its catalog once and returns only its reservations on a large waitlist", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const { register, profiles } = yield* contactFixture;
      let fetches = 0;
      const store = yield* contacts(async () => {
        fetches++;
        return profiles;
      });
      for (let i = 0; i < 1000; i++) yield* register(`user-${i}@example.com`, ["luna", "harin"]);
      const result = yield* store.select({ requestId: randomUUID(), count: 2 }, "load-check");
      expect(result.entries).toHaveLength(2);
      expect(result.entries.every((row) => ["luna", "harin"].includes(row.persona!.id))).toBe(true);
      expect(fetches).toBe(1);
      const empty = yield* register("no-likes@example.com", []);
      expect((yield* store.list).entries.find((row) => row.id === empty)).toMatchObject({
        likedPersonas: [],
        eligible: false,
      });
    }),
  );
});
