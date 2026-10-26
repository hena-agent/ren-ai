import { Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation } from "../conversations/conversations.ts";
import { photoData, photoKey, type PhotoBucket } from "./storage.ts";

export const hour = 3_600_000;
export const generationTimeout = 120_000;

export const photoStore = (bucket: PhotoBucket) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const enabled = () =>
      Effect.map(
        sql<{ enabled: number }>`SELECT enabled FROM photo_setting WHERE id = 1`,
        (rows) => rows[0]!.enabled === 1,
      );
    const sent = (conversationID: number, id: string) => sql`SELECT 1 FROM send
    WHERE conversation_id = ${conversationID} AND kind = 'photo' AND content = ${id}
      AND state IN ('recorded','uncertain','sent','delivered') LIMIT 1`;
    return {
      enabled,
      setEnabled: (value: boolean) =>
        Effect.asVoid(sql`UPDATE photo_setting SET enabled = ${Number(value)} WHERE id = 1`),
      receipt: (conversation: Conversation, callID: string) => sql<{
        id: string;
        state: string;
        expires_at: number | null;
      }>`SELECT id, state, expires_at FROM conversation_photo
      WHERE session_id = ${conversation.sessionID} AND call_id = ${callID} AND conversation_id = ${conversation.id}`,
      reserve: (conversation: Conversation, callID: string, id: string, includesMe: boolean) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const [row] = yield* sql<{ state: string }>`INSERT INTO conversation_photo
        (id, conversation_id, session_id, call_id, state, reserved_at, includes_me)
        SELECT ${id}, ${conversation.id}, ${conversation.sessionID}, ${callID},
          CASE WHEN (SELECT enabled FROM photo_setting WHERE id = 1) = 1 AND
            ((SELECT COUNT(*) FROM (SELECT 1 FROM conversation_photo WHERE conversation_id = ${conversation.id}
              AND state = 'taken' AND taken_at > ${now - 24 * hour} LIMIT 3)) +
             (SELECT COUNT(*) FROM (SELECT 1 FROM conversation_photo WHERE conversation_id = ${conversation.id}
              AND state = 'pending' AND reserved_at > ${now - generationTimeout} LIMIT 3))) < 3
            THEN 'pending' ELSE 'declined' END, ${now}, ${Number(includesMe)}
        FROM conversation WHERE id = ${conversation.id} AND session_id = ${conversation.sessionID}
          AND ended_at IS NULL AND rebuilding = 0
          AND NOT EXISTS (SELECT 1 FROM blocked WHERE handle = ${conversation.handle})
        ON CONFLICT(session_id, call_id) DO NOTHING RETURNING state`;
          if (row?.state !== "pending") return false;
          yield* sql`INSERT INTO photo_object VALUES(${id}, ${now + hour})`;
          return true;
        }).pipe(sql.withTransaction),
      decline: (id: string) =>
        Effect.asVoid(
          sql`UPDATE conversation_photo SET state = 'declined' WHERE id = ${id} AND state = 'pending'`,
        ),
      finish: (conversation: Conversation, id: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const rows =
            yield* sql`UPDATE conversation_photo SET state = 'taken', taken_at = ${now}, expires_at = ${now + hour}
        WHERE id = ${id} AND state = 'pending' AND reserved_at > ${now - generationTimeout}
          AND EXISTS (SELECT 1 FROM conversation WHERE id = ${conversation.id} AND session_id = ${conversation.sessionID}
            AND ended_at IS NULL AND rebuilding = 0)
          AND NOT EXISTS (SELECT 1 FROM blocked WHERE handle = ${conversation.handle})
          AND (SELECT enabled FROM photo_setting WHERE id = 1) = 1 RETURNING id`;
          if (!rows.length) return undefined;
          yield* sql`UPDATE photo_object SET due = ${now + hour} WHERE photo_id = ${id}`;
          return now + hour;
        }).pipe(sql.withTransaction),
      style: (conversation: Conversation) =>
        Effect.map(
          sql<{
            image_style: "anime" | "photo";
          }>`SELECT image_style FROM conversation WHERE id = ${conversation.id}`,
          (rows) => rows[0]?.image_style,
        ),
      continuity: (conversation: Conversation) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const [row] = yield* sql<{ id: string }>`SELECT p.id FROM send s JOIN conversation_photo p
        ON p.id = s.content AND p.conversation_id = s.conversation_id
        WHERE s.conversation_id = ${conversation.id} AND s.kind = 'photo' AND s.state IN ('sent','delivered')
          AND s.recorded_at > ${now - 6 * hour} AND p.includes_me = 1 AND p.state = 'taken'
        ORDER BY s.recorded_at DESC LIMIT 1`;
          return row ? yield* photoData(bucket, row.id) : undefined;
        }),
      sendable: (conversation: Conversation, id: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const [photo] = yield* sql<{
            expires_at: number;
          }>`SELECT expires_at FROM conversation_photo WHERE id = ${id}
        AND conversation_id = ${conversation.id} AND state = 'taken' AND expires_at > ${now}`;
          if (!photo || (yield* sent(conversation.id, id)).length) return undefined;
          const data = yield* photoData(bucket, id);
          if (
            photo.expires_at <= (yield* Clock.currentTimeMillis) ||
            (yield* sent(conversation.id, id)).length
          )
            return undefined;
          return data;
        }),
      nextCleanup: () =>
        Effect.map(
          sql<{
            due: number;
          }>`SELECT due FROM photo_object WHERE due IS NOT NULL ORDER BY due, photo_id LIMIT 1`,
          (rows) => rows[0]?.due,
        ),
      cleanup: () =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* sql<{ photo_id: string }>`SELECT photo_id FROM photo_object
        WHERE due IS NOT NULL AND due <= ${now} ORDER BY due, photo_id LIMIT 50`;
          for (const row of rows) {
            const [photo] = yield* sql<{
              conversation_id: number;
            }>`SELECT conversation_id FROM conversation_photo WHERE id = ${row.photo_id}`;
            if (photo && (yield* sent(photo.conversation_id, row.photo_id)).length) {
              // Pending admission retains bytes; check again if it later resolves as not sent.
              const [final] =
                yield* sql`SELECT 1 FROM send WHERE conversation_id = ${photo.conversation_id}
            AND kind = 'photo' AND content = ${row.photo_id} AND state IN ('sent','delivered') LIMIT 1`;
              yield* sql`UPDATE photo_object SET due = ${final ? null : now + 60_000} WHERE photo_id = ${row.photo_id}`;
            } else {
              yield* Effect.tryPromise(() => bucket.delete(photoKey(row.photo_id)));
              yield* sql`DELETE FROM photo_object WHERE photo_id = ${row.photo_id}`;
            }
          }
          return rows.length;
        }),
      remove: (conversationID: number) =>
        Effect.asVoid(
          sql`DELETE FROM conversation_photo WHERE conversation_id = ${conversationID}`,
        ),
    };
  });
