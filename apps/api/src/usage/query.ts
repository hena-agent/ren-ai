import { Effect } from "effect";
import { SqlClient } from "effect/sql";

type Entry = {
  id: string;
  sessionID: string;
  turnID: string | null;
  source: string;
  messageID: string | null;
  providerID: string | null;
  modelID: string | null;
  variant: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: string;
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cost: number | null;
  finish: string | null;
  errorType: string | null;
  upstreamStatus: number | null;
};
const sum = (
  entries: readonly Entry[],
  key: "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite" | "cost",
) => entries.reduce((total, entry) => total + (entry[key] ?? 0), 0);
const summarize = (entries: readonly Entry[]) => ({
  input: sum(entries, "input"),
  output: sum(entries, "output"),
  reasoning: sum(entries, "reasoning"),
  cacheRead: sum(entries, "cacheRead"),
  cacheWrite: sum(entries, "cacheWrite"),
  estimatedCostUSD: sum(entries, "cost"),
  unmeasuredEntries: entries.filter((entry) => entry.input === null).length,
});

export const usageQueries = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (conversationID: number, before?: number) =>
    Effect.gen(function* () {
      const sessions = yield* sql<{
        sessionID: string;
        messageCount: number;
        syncedAt: number | null;
        unavailable: number;
      }>`
      SELECT s.session_id AS sessionID, s.message_count AS messageCount, s.synced_at AS syncedAt, s.unavailable FROM usage_session s
      JOIN conversation c ON c.id = s.conversation_id AND c.usage_key = s.conversation_key WHERE c.id = ${conversationID}`;
      const [conversation] = yield* sql`SELECT 1 FROM conversation WHERE id = ${conversationID}`;
      if (!conversation) return undefined;
      const ids = sessions.map((session) => session.sessionID);
      const totals =
        yield* sql`SELECT source, provider_id AS providerID, model_id AS modelID, variant,
      COUNT(*) AS entries, SUM(input IS NULL) AS unmeasuredEntries,
      SUM(COALESCE(input, 0)) AS input, SUM(COALESCE(output, 0)) AS output,
      SUM(COALESCE(reasoning, 0)) AS reasoning, SUM(COALESCE(cache_read, 0)) AS cacheRead,
      SUM(COALESCE(cache_write, 0)) AS cacheWrite, SUM(COALESCE(cost, 0)) AS estimatedCostUSD
      FROM usage_entry WHERE session_id IN ${sql.in(ids)} GROUP BY source, provider_id, model_id, variant`;
      const turns = yield* sql<{
        id: string;
        sessionID: string;
        startedAt: number;
        endedAt: number | null;
        outcome: string;
      }>`
      SELECT id, session_id AS sessionID, started_at AS startedAt, ended_at AS endedAt, outcome FROM usage_turn
      WHERE session_id IN ${sql.in(ids)} AND (${before ?? null} IS NULL OR rowid < ${before ?? null}) ORDER BY rowid DESC LIMIT 51`;
      const selected = turns.slice(0, 50);
      const entries =
        yield* sql<Entry>`SELECT id, session_id AS sessionID, turn_id AS turnID, source, message_id AS messageID,
      provider_id AS providerID, model_id AS modelID, variant, started_at AS startedAt, ended_at AS endedAt, outcome,
      input, output, reasoning, cache_read AS cacheRead, cache_write AS cacheWrite, cost,
      finish, error_type AS errorType, upstream_status AS upstreamStatus FROM usage_entry
      WHERE session_id IN ${sql.in(ids)} AND (turn_id IN ${sql.in(selected.map((turn) => turn.id))} OR turn_id IS NULL) ORDER BY started_at, id`;
      const [cursor] = selected.length
        ? yield* sql<{
            row: number;
          }>`SELECT rowid AS row FROM usage_turn WHERE id = ${selected.at(-1)!.id}`
        : [];
      return {
        conversationID,
        sessions,
        totals,
        unattributed: entries.filter((entry) => entry.turnID === null),
        turns: selected.map((turn) => {
          const steps = entries.filter((entry) => entry.turnID === turn.id);
          return { ...turn, totals: summarize(steps), entries: steps };
        }),
        nextBefore: turns.length > 50 ? cursor!.row : null,
      };
    });
});
