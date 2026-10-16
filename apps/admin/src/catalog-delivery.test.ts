import { expect, test, vi } from "vitest";
import { catalogDelivery, wakeAlarm } from "./catalog-delivery.ts";
import { loggedRequest } from "./logging.ts";
import { memoryStorage } from "../test/memory-storage.ts";
import { request } from "../test/fixtures.ts";
import { captureWorkerLogs } from "../test/worker-logs.ts";
import { deferred } from "../test/queue.ts";

const commit = (delivery: ReturnType<typeof catalogDelivery>, run: () => Promise<void>) =>
  loggedRequest(
    request("/personas", {}),
    async () => {
      await delivery.save(run);
      return new Response(null);
    },
    () => {},
  );

test("saves and alarm delivery serialize so an earlier acknowledgement cannot erase a newer edit", async () => {
  const { storage } = memoryStorage();
  const events: string[] = [];
  const { promise: waiting, resolve: release } = deferred<void>();
  const notify = vi.fn<() => Promise<void>>(async () => {
    events.push("notify");
    if (notify.mock.calls.length === 1) await waiting;
  });
  const delivery = catalogDelivery(storage, notify);
  const first = commit(delivery, async () => {
    events.push("first commit");
  });
  await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
  const second = commit(delivery, async () => {
    events.push("second commit");
  });
  const alarm = delivery.flush();
  expect(events).toEqual(["first commit", "notify"]);
  release();
  await Promise.all([first, second, alarm]);
  expect(events).toEqual(["first commit", "notify", "second commit", "notify"]);
  expect(await delivery.pending()).toBe(false);
});

test("interrupted delivery is retried from durable intent with capped backoff, without delaying image alarms", async () => {
  const { stdout, stderr } = captureWorkerLogs();
  const { storage, clearAlarm } = memoryStorage();
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const notify = vi.fn<() => Promise<void>>(async () => {
    throw new Error("Unavailable");
  });
  try {
    await storage.put("catalog-notification", {
      requestId: "original-request",
      attempts: 0,
      due: now,
    });
    for (let attempt = 1; attempt <= 10; attempt++) {
      clearAlarm();
      // Recreate the delivery component on every attempt, as after an interrupted DO invocation.
      await catalogDelivery(storage, notify).flush();
      expect(notify).toHaveBeenCalledTimes(attempt);
      const alarm = (await storage.getAlarm())!;
      expect(alarm - now).toBe(Math.min(5000 * 2 ** (attempt - 1), 300_000));
      now = alarm;
    }
    await wakeAlarm(storage, now - 1000);
    expect(await storage.getAlarm()).toBe(now - 1000);
    await wakeAlarm(storage, now + 1000);
    expect(await storage.getAlarm()).toBe(now - 1000);
    notify.mockResolvedValueOnce();
    await catalogDelivery(storage, notify).flush();
    expect(await catalogDelivery(storage, notify).pending()).toBe(false);
  } finally {
    clock.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
