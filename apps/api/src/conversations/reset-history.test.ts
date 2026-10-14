import { Effect } from "effect";
import { expect, test } from "vitest";
import { currentMemory, resetFixture, onboardTestHandle } from "../../test/reset.test-helper.ts";

test.each(["renumbered", "missing"])(
  "reset cutoffs survive %s Messages rows and equal timestamps",
  async (mode) => {
    const f = await resetFixture("reset-history-");
    try {
      await f.run(
        Effect.gen(function* () {
          const host = yield* f.startMarked;
          const at = Date.now();
          yield* f.fake.text(f.handle, "first old fact", at);
          yield* f.fake.text(f.handle, "second old fact", at);
          const command = yield* f.fake.text(f.handle, "/reset", at);
          yield* onboardTestHandle(host, f.handle);
          const history = yield* f.fake.messages.after(0);
          yield* f.fake.replace(
            mode === "renumbered"
              ? history.map((row) => ({ ...row, id: row.id + 1000 }))
              : history.filter((row) => row.guid !== command.guid),
          );
          yield* host.operator.rebuild(f.handle);
          const restored = yield* currentMemory(host, f.handle);
          expect(restored.text).not.toContain("old fact");
          yield* f.fake.text(f.handle, "new equal timestamp", at);
          yield* f.fake.text(f.handle, "", Date.now(), {
            tapback: { emoji: "👍", targetGuid: command.guid, added: true },
          });
          const later = {
            id: 1,
            guid: "later-after-replacement",
            handle: f.handle,
            text: "new lower rowid",
            createdAt: Date.now() + 1000,
            fromMe: false,
          };
          yield* f.fake.redeliver(later);
          const memory = yield* currentMemory(host, f.handle);
          expect(memory.text).toContain("new equal timestamp");
          expect(memory.text).toContain("new lower rowid");
          expect(memory.text).not.toContain("<tapback");
          expect(memory.text).not.toContain("/reset");
        }),
      );
    } finally {
      await f.cleanup();
    }
  },
  60_000,
);
