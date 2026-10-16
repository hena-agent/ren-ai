import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { loggedJob, operation, requestId, writeLog } from "./logging.ts";

interface PendingCatalog {
  requestId: string;
  attempts: number;
  due: number;
}

export async function wakeAlarm(storage: DurableObjectStorage, due: number) {
  await storage.transaction(async (transaction) => {
    const alarm = await transaction.getAlarm();
    if (alarm === null || alarm > due) await transaction.setAlarm(due);
  });
}

/** One durable, coalesced notification: delivery always reads the latest committed Catalog. */
export function catalogDelivery(storage: DurableObjectStorage, notify: () => Promise<void>) {
  const key = "catalog-notification";
  let tail = Promise.resolve();
  const serial = <T>(run: () => Promise<T>) => {
    const next = tail.then(run);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const deliver = async () => {
    const pending = await storage.get<PendingCatalog>(key);
    if (!pending) return;
    if (pending.due > Date.now()) {
      await wakeAlarm(storage, pending.due);
      return;
    }
    // Persist and arm the retry before the network call, including a restart during delivery.
    const attempts = pending.attempts + 1;
    const due = Date.now() + Math.min(5000 * 2 ** Math.min(attempts - 1, 6), 300_000);
    await storage.put(key, { ...pending, attempts, due });
    await wakeAlarm(storage, due);
    try {
      await loggedJob(
        pending.requestId,
        {},
        () => operation("catalog.notify", {}, notify),
        writeLog,
        "/management/catalog/refresh",
      );
    } catch {
      return; // operation logged the diagnostic; the persisted alarm retries only this change.
    }
    await storage.delete(key);
  };
  return {
    pending: async () => Boolean(await storage.get<PendingCatalog>(key)),
    flush: () => serial(deliver),
    save: <T>(run: () => Promise<T>) =>
      serial(async () => {
        const previous = await storage.get<PendingCatalog>(key);
        // Intent precedes the D1 commit so a restart cannot lose a committed change's notification.
        const pending: PendingCatalog = { requestId: requestId(), attempts: 0, due: Date.now() };
        await storage.put(key, pending);
        await wakeAlarm(storage, pending.due + 1);
        let result: T;
        try {
          result = await run();
        } catch (cause) {
          if (previous) await storage.put(key, previous);
          else await storage.delete(key);
          throw cause;
        }
        await deliver();
        return result;
      }),
  };
}
