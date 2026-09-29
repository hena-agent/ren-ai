import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { IncomingMessage, Messages } from "../messages/messages.ts";

/** Applied to live intake and replay, including reactions to the old Memory. */
export const resetBoundary = (messages: Messages) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (row: IncomingMessage) =>
      Effect.gen(function* () {
        if ((yield* sql`SELECT 1 FROM reset WHERE guid = ${row.guid}`).length) return true;
        const [boundary] = yield* sql<{ guid: string; date: number; rowID: number }>`
      SELECT reset.guid, reset.date, reset.row_id AS rowID FROM reset
      JOIN conversation ON conversation.reset_guid = reset.guid
      JOIN user ON user.id = conversation.user_id WHERE user.handle = ${row.handle}`;
        if (!boundary) return false;
        const rows = yield* messages.recent(row.handle, 0);
        const cutoff = rows.find((item) => item.guid === boundary.guid)?.id ?? boundary.rowID;
        const earlier = (item: IncomingMessage) =>
          item.createdAt < boundary.date || (item.createdAt === boundary.date && item.id <= cutoff);
        if (earlier(row)) return true;
        if (row.tapback) {
          const target = rows.find((item) => item.guid === row.tapback!.targetGuid);
          if (!target || earlier(target)) return true;
        }
        if (!row.fromMe) return false;
        return (
          (yield* sql`SELECT 1 FROM send WHERE handle = ${row.handle}
      AND (kind = 'notice' OR conversation_id IS NULL)
      AND (guid = ${row.guid} OR (guid IS NULL AND content = ${row.text}))`).length > 0
        );
      });
  });
