import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { ApplicationStore } from "../src/application-store.ts";
import { storageMeter } from "./storage-meter.test-helper.ts";
import { koreaDay } from "@ren-ai/onboarding";

export async function metricsBudget(storage: DurableObjectStorage, store: ApplicationStore) {
  await store.metricsTick("budget-warmup");
  const meter = storageMeter(storage);
  const day = koreaDay(Date.now());
  const read = () =>
    store.handler(
      new Request(`https://api.test/management/metrics?from=${day}&to=${day}`, {
        headers: { Authorization: "Bearer management-test" },
      }),
    );
  try {
    for (let index = 0; index < 5; index++) await store.metricsTick("idle-budget");
    const idle = meter.totals();
    meter.reset();
    const before = await read();
    const small = meter.totals();
    storage.sql
      .exec(`WITH RECURSIVE days(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM days WHERE n < 9999)
      INSERT INTO metric_total(day, step, dimension, value, count) SELECT date('1970-01-01', '+' || n || ' days'), 'visit', 'total', '', 1 FROM days`);
    meter.reset();
    const after = await read();
    const large = meter.totals();
    const plan = storage.sql
      .exec<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT day, step, dimension, value, count FROM metric_total WHERE dimension = ? AND day >= ? AND day <= ? ORDER BY day, step, value",
        "total",
        day,
        day,
      )
      .toArray();
    const queue = (size: number) => {
      storage.sql.exec(
        `WITH RECURSIVE messages(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM messages WHERE n < ?)
        INSERT INTO discord_outbox(id, channel, content, due) SELECT 'budget-' || n, 'alerts', 'budget', 0 FROM messages`,
        size,
      );
      storage.sql.exec("UPDATE discord_delivery SET pending = ? WHERE channel = 'alerts'", size);
    };
    queue(4);
    meter.reset();
    await store.metricsTick("small-discord-backlog");
    const smallQueue = meter.totals();
    queue(10_000);
    meter.reset();
    await store.metricsTick("large-discord-backlog");
    const largeQueue = meter.totals();
    const queuePlan = storage.sql
      .exec<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT id, channel, content, attempts, due FROM discord_outbox WHERE channel = ? AND due <= ? ORDER BY due, id LIMIT 4",
        "alerts",
        Date.now(),
      )
      .toArray();
    return {
      idle,
      small,
      large,
      smallQueue,
      largeQueue,
      queuePlan,
      statuses: [before.status, after.status],
      plan,
    };
  } finally {
    meter.restore();
  }
}
