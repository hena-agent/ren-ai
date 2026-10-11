import { expect, test } from "vitest";
import { editingStorage } from "./editing-storage.ts";
import { memoryStorage } from "../test/memory-storage.ts";
import { createAdmin } from "./admin.ts";
import { cloudflareFixture } from "../test/cloudflare-fixture.ts";
import { character, generator, newToken, request } from "../test/fixtures.ts";

test("private draft and batch rows are restored independently and changed task snapshots are persisted", async () => {
  const { store } = await cloudflareFixture();
  const { storage, values } = memoryStorage();
  const persistence = editingStorage(storage);
  const empty = await persistence.load();
  expect(empty).toEqual({ drafts: [], queue: { jobs: [], keys: [], pending: [] } });
  const admin = createAdmin(store, "test-password", "", {
    generator,
    log: () => {},
    persistence: { saved: empty, checkpoint: persistence.save, wake: async () => {} },
  });
  await admin(
    request("/personas", {
      ...character,
      draft: await newToken(admin),
      intent: "generate",
      portraitInstructions: "private photo direction",
    }),
  );
  const restored = await editingStorage(storage).load();
  expect(restored.queue.pending).toHaveLength(1);
  expect(restored.queue.keys).toHaveLength(1);
  expect(restored.queue.jobs[0]!.batch.prompts[0]).toBe("private photo direction");
  expect([...values.keys()].some((key) => key.startsWith("job:"))).toBe(true);
  await persistence.save(restored);
  restored.queue.jobs[0]!.tasks[0]!.state = "saving";
  await persistence.save(restored);
  expect((await editingStorage(storage).load()).queue.jobs[0]!.tasks[0]!.state).toBe("saving");
});
