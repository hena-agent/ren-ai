import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { AdminSnapshot } from "./admin-state.ts";
import type { Draft } from "./draft.ts";
import type { QueueSnapshot } from "./image-queue.ts";

/** Store each draft and batch separately: one global JSON value hits the KV value limit. */
export function editingStorage(storage: DurableObjectStorage) {
  let previous: AdminSnapshot | undefined;
  return {
    load: async (): Promise<AdminSnapshot> => {
      const [drafts, jobs, keys, pending] = await Promise.all([
        storage.list<Draft>({ prefix: "draft:" }),
        storage.list<QueueSnapshot["jobs"][number]>({ prefix: "job:" }),
        storage.list<readonly [string, string]>({ prefix: "key:" }),
        storage.get<readonly string[]>("pending"),
      ]);
      previous = {
        drafts: [...drafts].map(([key, draft]) => [key.slice(6), draft]),
        queue: { jobs: [...jobs.values()], keys: [...keys.values()], pending: pending ?? [] },
      };
      return previous;
    },
    save: async (snapshot: AdminSnapshot) => {
      const oldDrafts = new Map(previous?.drafts);
      const oldJobs = new Map(previous?.queue.jobs.map((job) => [job.id, job]));
      const oldKeys = new Map(previous?.queue.keys);
      await storage.transaction(async (transaction) => {
        const ids = new Set(snapshot.queue.jobs.map((job) => job.id));
        for (const id of oldJobs.keys()) if (!ids.has(id)) await transaction.delete(`job:${id}`);
        for (const [id, draft] of snapshot.drafts)
          if (!same(oldDrafts.get(id), draft)) await transaction.put(`draft:${id}`, draft);
        for (const job of snapshot.queue.jobs)
          if (!same(oldJobs.get(job.id), job)) await transaction.put(`job:${job.id}`, job);
        for (const [key, id] of snapshot.queue.keys)
          if (oldKeys.get(key) !== id) {
            const digest = Buffer.from(
              await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
            ).toString("hex");
            await transaction.put(`key:${digest}`, [key, id]);
          }
        await transaction.put("pending", snapshot.queue.pending);
      });
      // Snapshot contains mutable tasks; detach it before the next transition.
      previous = structuredClone(snapshot);
    },
  };
}

const same = (left: object | undefined, right: object) =>
  JSON.stringify(left) === JSON.stringify(right);
