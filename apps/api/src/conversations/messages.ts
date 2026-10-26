import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { remoteMessages } from "@ren-ai/imsg/client";

type History = Pick<Effect.Success<ReturnType<typeof remoteMessages>>, "history">;

/** Read the transport ledger without starting a persona or replaying model work. */
export const conversationHistory = (messages: History, id: number, before?: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [scope] = yield* sql<{
      handle: string;
      startedAt: number;
      endedAt: number | null;
      until: number | null;
    }>`SELECT u.handle, c.started_at AS startedAt, c.ended_at AS endedAt,
      (SELECT n.started_at FROM conversation n WHERE n.user_id = c.user_id AND n.id > c.id ORDER BY n.id LIMIT 1) AS until
      FROM conversation c JOIN user u ON u.id = c.user_id WHERE c.id = ${id}`;
    if (!scope) return undefined;
    const rows = yield* messages.history({
      handle: scope.handle,
      since: scope.startedAt,
      until: scope.until,
      ...(before !== undefined && { before }),
    });
    const page = rows.slice(0, 50);
    const sends = page.length
      ? yield* sql<{ guid: string; conversationID: number | null }>`
      SELECT guid, conversation_id AS conversationID FROM send
      WHERE guid IN ${sql.in(page.map((row) => row.guid))}`
      : [];
    const owners = new Map(sends.map((send) => [send.guid, send.conversationID]));
    const entries = page.filter((row) => {
      if (row.fromMe && owners.has(row.guid)) return owners.get(row.guid) === id;
      return scope.endedAt === null || row.createdAt <= scope.endedAt;
    });
    return { entries, nextBefore: rows.length > 50 ? page[49]!.id : null };
  });

export const conversationMessages = (messages: History, id: number, before?: number) =>
  conversationHistory(messages, id, before).pipe(
    Effect.map(
      (history) =>
        history && {
          ...history,
          entries: history.entries.toReversed().map(({ handle: _handle, attachments, ...row }) => ({
            ...row,
            attachments: (attachments ?? []).map(({ mimeType, missing }) => ({
              mimeType,
              missing,
            })),
          })),
        },
    ),
  );
