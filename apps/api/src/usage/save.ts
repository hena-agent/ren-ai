import type { Session } from "@opencode/schema/session";
import type { SessionMessage } from "@opencode/schema/session-message";
import type { TokenUsage } from "@opencode/schema/token-usage";
import type { Model } from "@opencode/schema/model";
import { DateTime, Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

const counters = (tokens?: TokenUsage.Info) => ({
  input: tokens?.input ?? null,
  output: tokens?.output ?? null,
  reasoning: tokens?.reasoning ?? null,
  cache_read: tokens?.cache.read ?? null,
  cache_write: tokens?.cache.write ?? null,
});
const modelDetails = (model?: Model.Ref) => ({
  provider_id: model?.providerID ?? null,
  model_id: model?.id ?? null,
  variant: model?.variant ?? null,
});
const primary = (message: SessionMessage.Assistant) => ({
  ...counters(message.tokens),
  ...modelDetails(message.model),
  source: "primary",
  cost: message.cost ?? null,
  ended_at: message.time.completed ? DateTime.toEpochMillis(message.time.completed) : null,
  outcome: message.error ? "failed" : message.time.completed ? "succeeded" : "running",
  finish: message.finish ?? null,
  error_type: message.error?.type ?? null,
  upstream_status: message.error?.status ?? null,
});
const compaction = (message: SessionMessage.Compaction) => ({
  ...counters(message.status === "running" ? undefined : message.tokens),
  ...modelDetails(message.status === "completed" ? message.model : undefined),
  source: "compaction",
  cost: message.status === "running" ? null : (message.cost ?? null),
  ended_at: message.status === "running" ? null : DateTime.toEpochMillis(message.time.created),
  outcome: message.status === "completed" ? "succeeded" : message.status,
  finish: null,
  error_type: message.status === "failed" ? message.error.type : null,
  upstream_status: null,
});

/** Idle markers delimit native turns, including prompts delivered during execution. */
export const saveUsage = (
  sql: SqlClient.SqlClient,
  session: Session.Info,
  messages: readonly SessionMessage.Info[],
  now: number,
) =>
  Effect.gen(function* () {
    let turnID: string | null = null;
    for (const message of messages) {
      const created = DateTime.toEpochMillis(message.time.created);
      if (message.type === "idle") {
        yield* sql`UPDATE usage_turn SET ended_at = ${created}, outcome = ${message.outcome} WHERE id = ${turnID}`;
        yield* sql`UPDATE usage_entry SET outcome = 'unmeasured', ended_at = ${created}
        WHERE turn_id = ${turnID} AND outcome = 'running'`;
        turnID = null;
        continue;
      }
      if (!["user", "synthetic", "assistant", "compaction"].includes(message.type)) continue;
      if (!turnID) {
        turnID = message.id;
        yield* sql`INSERT OR IGNORE INTO usage_turn (id, session_id, started_at) VALUES (${turnID}, ${session.id}, ${created})`;
      }
      if (message.type !== "assistant" && message.type !== "compaction") continue;
      const entry = {
        id: message.id,
        session_id: session.id,
        turn_id: turnID,
        message_id: message.id,
        started_at: created,
        ...(message.type === "assistant" ? primary(message) : compaction(message)),
      };
      yield* sql`INSERT INTO usage_entry ${sql.insert(entry)}
      ON CONFLICT(id) DO UPDATE SET turn_id=excluded.turn_id, provider_id=excluded.provider_id, model_id=excluded.model_id,
        variant=excluded.variant, ended_at=excluded.ended_at, outcome=excluded.outcome, input=excluded.input,
        output=excluded.output, reasoning=excluded.reasoning, cache_read=excluded.cache_read, cache_write=excluded.cache_write,
        cost=excluded.cost, finish=excluded.finish, error_type=excluded.error_type, upstream_status=excluded.upstream_status`;
    }
    // Session totals also include auxiliary work (e.g. titles) with no per-message attribution.
    // Preserve the difference separately instead of inventing a turn or model for it.
    yield* sql`INSERT INTO usage_entry (id, session_id, source, started_at, outcome, input, output, reasoning, cache_read, cache_write, cost)
    SELECT ${session.id + ":overhead"}, ${session.id}, 'session-overhead', ${DateTime.toEpochMillis(session.time.created)}, 'unattributed',
      ${session.tokens.input} - COALESCE(SUM(input), 0), ${session.tokens.output} - COALESCE(SUM(output), 0),
      ${session.tokens.reasoning} - COALESCE(SUM(reasoning), 0), ${session.tokens.cache.read} - COALESCE(SUM(cache_read), 0),
      ${session.tokens.cache.write} - COALESCE(SUM(cache_write), 0), ${session.cost} - COALESCE(SUM(cost), 0)
    FROM usage_entry WHERE session_id = ${session.id} AND source != 'session-overhead'
    ON CONFLICT(id) DO UPDATE SET input=excluded.input, output=excluded.output, reasoning=excluded.reasoning,
      cache_read=excluded.cache_read, cache_write=excluded.cache_write, cost=excluded.cost`;
    yield* sql`UPDATE usage_session SET message_count = ${messages.length}, synced_at = ${now}, unavailable = 0 WHERE session_id = ${session.id}`;
  });
