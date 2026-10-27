import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { koreaDay } from "@ren-ai/onboarding";
import { lifecycleMetric } from "./lifecycle.ts";
import { changeAlert } from "./discord.ts";

const milestones = { sent: 1, failed: 2, uncertain: 4, firstReply: 8, resolved: 128 } as const;

export const resolveGreetingAlert = (id: number, callID: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      registration: string;
    }>`UPDATE conversation SET metric_flags = metric_flags | ${milestones.resolved} WHERE id = ${id} AND registration_id IS NOT NULL
      AND NOT (metric_flags & ${milestones.sent})
      AND EXISTS (SELECT 1 FROM send WHERE conversation_id = ${id} AND tool_call_id = ${callID} AND kind = 'text') RETURNING registration_id AS registration`;
    for (const row of rows) yield* changeAlert(`greeting:${row.registration}`, false);
  });

export const greetingMetric = (id: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [conversation] = yield* sql<{
      flags: number;
    }>`SELECT metric_flags AS flags FROM conversation WHERE id = ${id} AND registration_id IS NOT NULL`;
    if (!conversation || conversation.flags & milestones.sent) return;
    const [row] = yield* sql<{
      registration: string;
      persona: string;
      at: number;
      state: string;
      flags: number;
    }>`SELECT c.registration_id AS registration, c.persona_id AS persona, s.updated_at AS at, s.state, c.metric_flags AS flags
    FROM conversation c JOIN send s ON s.id = (SELECT id FROM send WHERE conversation_id = c.id AND kind = 'text' AND state != 'not_sent' ORDER BY CASE WHEN state IN ('sent', 'delivered') THEN 0 ELSE 1 END, id LIMIT 1)
    WHERE c.id = ${id} AND c.registration_id IS NOT NULL AND s.updated_at >= (SELECT at FROM metric_epoch)`;
    if (!row || row.state === "recorded") return;
    const sent = row.state === "sent" || row.state === "delivered";
    const flag = sent
      ? milestones.sent
      : row.state === "failed"
        ? milestones.failed
        : milestones.uncertain;
    if (row.flags & flag) return;
    yield* sql`UPDATE conversation SET metric_flags = metric_flags | ${flag}, metric_greeting_at = CASE WHEN ${Number(sent)} THEN COALESCE(metric_greeting_at, ${row.at}) ELSE metric_greeting_at END WHERE id = ${id}`;
    yield* lifecycleMetric(
      row.registration,
      sent ? "greeting_sent" : row.state === "failed" ? "greeting_failed" : "greeting_uncertain",
      row.persona,
      [],
      id,
      row.at,
    );
    yield* changeAlert(`greeting:${row.registration}`, !sent && !(row.flags & milestones.resolved));
  });

export const incomingMetric = (id: number, at: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      registration: string;
      persona: string;
      greeting: number | null;
      active: string | null;
      flags: number;
    }>`SELECT registration_id AS registration, persona_id AS persona, metric_greeting_at AS greeting, metric_active_day AS active, metric_flags AS flags
    FROM conversation WHERE id = ${id} AND registration_id IS NOT NULL`;
    if (!row) return;
    const excluded =
      yield* sql`SELECT 1 FROM discovery_registration r JOIN test_handle t ON t.handle = r.handle WHERE r.id = ${row.registration}`;
    const day = koreaDay(at);
    if (!excluded.length && row.active !== day) {
      yield* lifecycleMetric(row.registration, "active", row.persona, [], id, at);
      yield* sql`UPDATE conversation SET metric_active_day = ${day} WHERE id = ${id}`;
    }
    if (row.greeting === null || at < row.greeting) return;
    let flags = row.flags;
    if (!(flags & milestones.firstReply)) {
      yield* lifecycleMetric(row.registration, "first_reply", row.persona, [], id, at);
      flags |= milestones.firstReply;
    }
    const days = (Date.parse(day) - Date.parse(koreaDay(row.greeting))) / 86_400_000;
    for (const [threshold, flag, step] of [
      [1, 16, "retention_1"],
      [7, 32, "retention_7"],
      [30, 64, "retention_30"],
    ] as const) {
      if (days < threshold || flags & flag) continue;
      yield* lifecycleMetric(row.registration, step, row.persona, [], id, row.greeting);
      flags |= flag;
    }
    if (flags !== row.flags)
      yield* sql`UPDATE conversation SET metric_flags = ${flags} WHERE id = ${id}`;
  });

export const contactOutcome = (
  id: string,
  state: "active" | "blocked" | "failed" | "unreachable" | "review",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      persona: string;
      conversation: number | null;
      flags: number;
    }>`SELECT d.persona_id AS persona, c.id AS conversation, COALESCE(c.metric_flags, 0) AS flags FROM discovery_contact d LEFT JOIN conversation c ON c.registration_id = d.registration_id WHERE d.registration_id = ${id}`;
    if (["failed", "unreachable", "review"].includes(state)) {
      yield* lifecycleMetric(
        id,
        state === "review" ? "greeting_uncertain" : "greeting_failed",
        row!.persona,
        [],
        row!.conversation,
      );
      yield* changeAlert(`greeting:${id}`, !(row!.flags & (milestones.resolved | milestones.sent)));
    } else yield* changeAlert(`greeting:${id}`, false);
  });
