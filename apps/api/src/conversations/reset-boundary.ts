import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { IncomingMessage, Messages } from "@ren-ai/imsg";

/** Applied to live intake and replay, including reactions to the old Memory. */
export const resetBoundary = Effect.fnUntraced(function* (messages: Messages) {
  const sql = yield* SqlClient.SqlClient;
  return Effect.fnUntraced(function* (row: IncomingMessage) {
    if ((yield* sql`SELECT 1 FROM reset WHERE guid = ${row.guid}`).length) return true;
    const [boundary] = yield* sql<{ guid: string; date: number; rowID: number }>`
      SELECT guid, date, row_id AS rowID FROM reset WHERE handle = ${row.handle}
      ORDER BY date DESC, row_id DESC LIMIT 1`;
    if (!boundary) return false;
    const [reset] = yield* messages.recent(row.handle, 0, { guid: boundary.guid, limit: 1 });
    const cutoff = reset?.id ?? boundary.rowID;
    const earlier = (item: IncomingMessage) =>
      item.createdAt < boundary.date || (item.createdAt === boundary.date && item.id <= cutoff);
    if (earlier(row)) return true;
    if (row.tapback) {
      const [target] = yield* messages.recent(row.handle, 0, {
        guid: row.tapback.targetGuid,
        limit: 1,
      });
      if (!target || earlier(target)) return true;
    }
    if (!row.fromMe) return false;
    return (
      (yield* sql`SELECT 1 FROM send WHERE handle = ${row.handle}
      AND conversation_id IS NULL
      AND (guid = ${row.guid} OR (guid IS NULL AND content = ${row.text}))`).length > 0
    );
  });
});
