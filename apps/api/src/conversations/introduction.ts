import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation } from "./conversations.ts";

/** Prefix the first new persona bubble so a shared iMessage thread never implies continuity. */
export const introduceRelationship = (conversation: Conversation, text: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ locale: string }>`SELECT u.locale FROM conversation c
    JOIN user u ON u.id = c.user_id WHERE c.id = ${conversation.id} AND c.ended_at IS NULL
    AND EXISTS (SELECT 1 FROM conversation old WHERE old.user_id = u.id AND old.ended_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM send WHERE conversation_id = c.id AND kind = 'text'
      AND state IN ('recorded', 'uncertain', 'sent', 'delivered'))`;
    if (!row) return text;
    const notice =
      row.locale === "ko"
        ? "[Ren AI] 지금부터 다른 페르소나와의 새로운 대화입니다. 이전 관계의 기억은 공유되지 않습니다."
        : row.locale === "ja"
          ? "[Ren AI] 別のペルソナとの新しい会話です。以前の関係の記憶は共有されません。"
          : "[Ren AI] This is a new conversation with a different persona. Memories from your previous relationship are not shared.";
    return `${notice}\n\n${text}`;
  });
