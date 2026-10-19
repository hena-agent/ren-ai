import { expect, test, vi } from "vitest";
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
  const response = await admin(
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
  const transaction = vi.spyOn(storage, "transaction");
  for (let poll = 0; poll < 3; poll++)
    expect((await admin(request(response.headers.get("location")!))).status).toBe(200);
  expect(transaction).not.toHaveBeenCalled();
  await persistence.save(restored);
  const put = vi.spyOn(storage, "put");
  await persistence.save({ ...restored, queue: { ...restored.queue, pending: [] } });
  expect(put).toHaveBeenCalledExactlyOnceWith("pending", []);
  put.mockRestore();
  restored.queue.jobs[0]!.tasks[0]!.state = "saving";
  await persistence.save(restored);
  expect((await editingStorage(storage).load()).queue.jobs[0]!.tasks[0]!.state).toBe("saving");
  await persistence.save({ ...restored, queue: { ...restored.queue, jobs: [], pending: [] } });
  const deleted = await editingStorage(storage).load();
  expect(deleted.queue.jobs).toEqual([]);
  expect(deleted.queue.keys).toHaveLength(1);
  expect([...values.keys()].some((key) => key.startsWith("job:"))).toBe(false);
});

test("unchanged and concurrent checkpoints perform no storage transaction, including after a restart", async () => {
  const { storage } = memoryStorage();
  let persistence = editingStorage(storage);
  const snapshot = await persistence.load();
  const transaction = vi.spyOn(storage, "transaction");
  await Promise.all([persistence.save(snapshot), persistence.save(snapshot)]);
  expect(transaction).not.toHaveBeenCalled();
  snapshot.queue.pending = ["queued"];
  await Promise.all([persistence.save(snapshot), persistence.save(snapshot)]);
  expect(transaction).toHaveBeenCalledTimes(1);
  persistence = editingStorage(storage);
  const restored = await persistence.load();
  transaction.mockClear();
  await persistence.save(restored);
  expect(transaction).not.toHaveBeenCalled();
});

test("a failed checkpoint remains retryable and does not block later snapshots", async () => {
  const { storage } = memoryStorage();
  const persistence = editingStorage(storage);
  const snapshot = await persistence.load();
  const transaction = vi
    .spyOn(storage, "transaction")
    .mockRejectedValueOnce(new Error("storage unavailable"));
  const changed = { ...snapshot, queue: { ...snapshot.queue, pending: ["queued"] } };
  await expect(persistence.save(changed)).rejects.toThrow("storage unavailable");
  await persistence.save(changed);
  expect(transaction).toHaveBeenCalledTimes(2);
  expect((await editingStorage(storage).load()).queue.pending).toEqual(["queued"]);
});
