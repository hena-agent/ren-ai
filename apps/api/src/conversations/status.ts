import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { ConversationEntry, ConversationQuery, PublicPersona } from "@ren-ai/onboarding";

type Entry = typeof ConversationEntry.Type;
type Row = Omit<Entry, "personaName" | "farewell" | "notice" | "canNotify"> & {
  canNotify: number;
  farewellPending: number | null;
  noticePending: number | null;
  farewellState: string | null;
  noticeState: string | null;
};
const deliveryState = (pending: number | null, state: string | null): Entry["notice"] => {
  if (state === "recorded" || state === "uncertain") return "uncertain";
  if (state === "sent" || state === "delivered") return state;
  if (state === "failed" || state === "not_sent") return "failed";
  return pending === 1 ? "queued" : "cancelled";
};

/** Database identity remains readable without starting or contacting OpenCode. */
export const conversationStatus = (catalog: () => Promise<readonly PublicPersona[]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const load = (input: typeof ConversationQuery.Type, id?: number, handle?: string) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<Row>`SELECT c.id, u.handle, c.persona_id AS personaID, c.session_id AS sessionID,
      c.started_at AS startedAt, c.ended_at AS endedAt, e.stopped_at AS stoppedAt,
      (c.ended_at IS NOT NULL AND e.consumed_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM blocked WHERE handle = u.handle)
        AND NOT EXISTS(SELECT 1 FROM conversation newer WHERE newer.user_id = u.id AND newer.id > c.id)) AS canNotify,
      c.last_received_at AS lastReceivedAt,
      (SELECT MAX(recorded_at) FROM send WHERE conversation_id = c.id AND state IN ('sent','delivered')) AS lastSentAt,
      e.farewell_pending AS farewellPending, e.notice_pending AS noticePending,
      (SELECT state FROM send WHERE conversation_id = c.id AND tool_call_id = e.call_id || ':farewell:' || e.farewell_attempt) AS farewellState,
      (SELECT state FROM send WHERE conversation_id = c.id AND tool_call_id = e.call_id || ':notice:' || e.notice_attempt) AS noticeState
      FROM conversation c JOIN user u ON u.id = c.user_id LEFT JOIN conversation_end e ON e.conversation_id = c.id
      WHERE (${input.filter} = 'all' OR (${input.filter} = 'active' AND c.ended_at IS NULL) OR (${input.filter} = 'ended' AND c.ended_at IS NOT NULL))
      AND (${input.before ?? null} IS NULL OR c.id < ${input.before ?? null})
      AND (${id ?? null} IS NULL OR c.id = ${id ?? null}) AND (${handle ?? null} IS NULL OR u.handle = ${handle ?? null})
      AND (instr(lower(u.handle), lower(${input.search})) > 0 OR instr(lower(c.persona_id), lower(${input.search})) > 0
        OR instr(lower(c.session_id), lower(${input.search})) > 0 OR CAST(c.id AS TEXT) = ${input.search})
      ORDER BY c.id DESC LIMIT 26`;
        const profiles = yield* Effect.tryPromise({
          try: catalog,
          catch: (cause) => new Error("Persona names unavailable", { cause }),
        });
        const names = new Map(profiles.map((persona) => [persona.id, persona.name]));
        return rows.map(
          ({ farewellPending, noticePending, farewellState, noticeState, canNotify, ...row }) => ({
            ...row,
            personaName: names.get(row.personaID) ?? row.personaID,
            farewell: deliveryState(farewellPending, farewellState),
            notice: deliveryState(noticePending, noticeState),
            canNotify: canNotify === 1,
          }),
        );
      });
    const list = (input: typeof ConversationQuery.Type) =>
      Effect.gen(function* () {
        const entries = yield* load(input);
        return {
          entries: entries.slice(0, 25),
          nextBefore: entries.length > 25 ? entries[24]!.id : null,
        };
      });
    const detail = (id: number, registrationsBefore?: string) =>
      Effect.gen(function* () {
        const [entry] = yield* load({ filter: "all", search: "" }, id);
        if (!entry) return undefined;
        const history = yield* load({ filter: "all", search: "" }, undefined, entry.handle);
        const registrations = yield* sql<{
          id: string;
          createdAt: number;
          archivedAt: number | null;
          personaID: string | null;
          state: string | null;
          selectionID: string | null;
        }>`
      SELECT r.id, r.created_at AS createdAt, r.archived_at AS archivedAt, d.persona_id AS personaID,
      d.state, d.selection_id AS selectionID FROM discovery_registration r
      LEFT JOIN discovery_contact d ON d.registration_id = r.id WHERE r.handle = ${entry.handle}
      AND (${registrationsBefore ?? null} IS NULL OR r.created_at <
        (SELECT created_at FROM discovery_registration WHERE id = ${registrationsBefore ?? null} AND handle = ${entry.handle})
        OR (r.created_at = (SELECT created_at FROM discovery_registration WHERE id = ${registrationsBefore ?? null} AND handle = ${entry.handle}) AND r.id < ${registrationsBefore ?? null}))
      ORDER BY r.created_at DESC, r.id DESC LIMIT 26`;
        return {
          entry,
          history: history.slice(0, 25),
          registrations: registrations.slice(0, 25),
          ...(registrations.length > 25 && { registrationNextBefore: registrations[24]!.id }),
        };
      });
    return { list, detail };
  });
