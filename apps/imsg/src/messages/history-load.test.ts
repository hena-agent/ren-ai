import { Effect } from "effect";
import { expect, test } from "vitest";
import { makeImsgMessages } from "./imsg.ts";
import { fixture, handle, raw } from "./imsg.fake.ts";
import { TestClock } from "effect/testing";

test("conversation reads stop rescanning unrelated history and invalidate on database replacement", async () => {
  const f = fixture(100);
  const rows = Array.from({ length: 10_000 }, (_, i) => ({
    ...raw[0]!,
    id: i + 1,
    guid: `history-${i}`,
    chat_identifier: `user-${i}@example.com`,
    chat_id: i + 2,
  }));
  rows.push({ ...raw[0]!, id: 10_001 });
  f.replace(rows);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const messages = yield* makeImsgMessages(f.alertsService);
        expect(yield* messages.lastOutgoingStatus(handle)).toBeDefined();
        f.commands.length = 0;
        for (let i = 0; i < 10; i++) {
          expect(yield* messages.recent(handle, 0)).toHaveLength(1);
          expect(yield* messages.lastOutgoingStatus(handle)).toBeDefined();
          expect(yield* messages.textStatus(handle, 0)).toBe("sent");
        }
        expect(f.commands.filter((c) => c.method === "messages.after")).toHaveLength(0);
        expect(
          f.commands.some((c) => c.method === "messages.after" && c.params["since_rowid"] === 0),
        ).toBe(false);
        f.replace([
          {
            ...raw[0]!,
            id: 1,
            chat_id: 77,
            guid: "replacement",
            created_at: "2026-10-01T00:00:00Z",
          },
        ]);
        expect((yield* messages.recent(handle, 0)).map((row) => row.guid)).toEqual(["replacement"]);
        expect(f.commands.at(-1)?.params["chat_id"]).toBe(77);
        expect(yield* messages.lastOutgoingStatus("user-999@example.com")).toBeUndefined();
      }).pipe(Effect.provide(f.dependencies)),
    ),
  );
});

test("watch startup and overflow resume from the bookmark without reading unrelated history", async () => {
  const f = fixture(100);
  f.replace(
    Array.from({ length: 10_000 }, (_, i) => ({ ...raw[0]!, id: i + 1, guid: `row-${i}` })),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const messages = yield* makeImsgMessages(f.alertsService);
        const seen: number[] = [];
        yield* messages.follow(9999, (row) =>
          Effect.sync(() => {
            seen.push(row.id);
          }),
        );
        for (let i = 0; i < 1000 && !f.commands.some((c) => c.method === "watch.subscribe"); i++)
          yield* Effect.yieldNow;
        expect(seen).toEqual([10000]);
        expect(f.commands.filter((c) => c.method === "messages.after")).toHaveLength(1);
        f.connections[0]!.notify("watch.overflow", { subscription: 1 });
        yield* TestClock.adjust("1 second");
        for (
          let i = 0;
          i < 100 && f.commands.filter((c) => c.method === "watch.subscribe").length < 2;
          i++
        )
          yield* Effect.yieldNow;
        expect(f.commands.filter((c) => c.method === "watch.subscribe")).toHaveLength(2);
        expect(f.commands.filter((c) => c.method === "messages.after")).toHaveLength(2);
        expect(seen).toEqual([10000]);
      }).pipe(Effect.provide(f.dependencies), Effect.provide(TestClock.layer())),
    ),
  );
});

test("a bounded catch-up returns a prefix without reading the rest of the backlog", async () => {
  const f = fixture(500);
  f.replace(Array.from({ length: 10000 }, (_, i) => ({ ...raw[0]!, id: i + 1 })));
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const messages = yield* makeImsgMessages(f.alertsService);
        expect(yield* messages.after(0, 100)).toHaveLength(100);
        expect(f.commands).toHaveLength(1);
        expect((yield* messages.after(100, 1))[0]?.id).toBe(101);
        expect(f.commands).toHaveLength(2);
      }).pipe(Effect.provide(f.dependencies)),
    ),
  );
});
