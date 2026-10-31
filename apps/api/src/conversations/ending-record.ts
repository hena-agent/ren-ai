import { createHash, randomBytes } from "node:crypto";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { Conversation } from "./conversations.ts";
import { lifecycleMetric } from "../metrics/lifecycle.ts";
import { changeAlert } from "../metrics/alerts.ts";

export const reselectionHash = (token: string) => createHash("sha256").update(token).digest("hex");

type Initiator = "persona" | "operator" | "user";

const userEnding = {
  ko: "요청에 따라 관계가 종료되었습니다.",
  ja: "ご希望により関係を終了しました。",
  en: "Your relationship has ended at your request.",
};

const notice = (locale: string, token: string, initiator: Initiator) => {
  const opening =
    initiator === "user"
      ? userEnding[locale === "ko" || locale === "ja" ? locale : "en"]
      : initiator === "operator"
        ? locale === "ko"
          ? "운영자가 이 페르소나와의 관계를 종료했습니다."
          : locale === "ja"
            ? "運営者がこのペルソナとの関係を終了しました。"
            : "The operator has ended your relationship with this persona."
        : "";
  const text =
    locale === "ko"
      ? "이 페르소나와의 관계가 종료되었습니다. 아래 링크에서 다른 페르소나를 선택할 수 있어요. 기존 iMessage 주소로 신청해 주세요. 선택 후 첫 연락까지 기다림이 있을 수 있습니다."
      : locale === "ja"
        ? "このペルソナとの関係は終了しました。以下のリンクから別のペルソナを選べます。同じiMessageアドレスでお申し込みください。最初の連絡までお待ちいただく場合があります。"
        : "This relationship has ended. You can choose another persona below using your existing iMessage address. There may be a wait before the first message.";
  const replies =
    locale === "ko"
      ? "이 주소는 안내 전용이라 답장을 확인하지 않습니다."
      : locale === "ja"
        ? "このアドレスは通知専用のため、返信は確認していません。"
        : "This address only sends notifications and doesn't read replies.";
  return `[RenAI] ${opening ? `${opening} ` : ""}${text}\n${replies}\nhttps://renai.im/#reselect=${token}`;
};

/** The caller owns the transaction and admission fence. No executor or physical-send dependency. */
export const recordEnding = (
  conversation: Conversation,
  farewell: string,
  callID: string,
  initiator: Initiator,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [user] = yield* sql<{
      locale: string;
    }>`SELECT locale FROM user WHERE handle = ${conversation.handle}`;
    const token = randomBytes(32).toString("hex");
    const now = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO conversation_end(conversation_id, call_id, farewell, notice, token_hash, farewell_pending, initiator)
    VALUES (${conversation.id}, ${callID}, ${farewell}, ${notice(user!.locale, token, initiator)}, ${reselectionHash(token)}, ${Number(initiator === "persona")}, ${initiator})`;
    yield* sql`UPDATE conversation SET ended_at = ${now}, rebuilding = 0 WHERE id = ${conversation.id}`;
    yield* sql`DELETE FROM follow_up WHERE conversation_id = ${conversation.id}`;
    yield* sql`DELETE FROM failed_turn WHERE session_id = ${conversation.sessionID}`;
    yield* sql`DELETE FROM application_work WHERE name = ${`turn:${conversation.sessionID}`}`;
    yield* sql`DELETE FROM application_checkpoint WHERE name = ${`replay:${conversation.sessionID}`}`;
    yield* sql`DELETE FROM persona_assignment WHERE handle = ${conversation.handle}`;
    yield* sql`UPDATE user SET persona_id = NULL WHERE handle = ${conversation.handle}`;
    const [registration] = yield* sql<{
      id: string;
    }>`SELECT registration_id AS id FROM conversation WHERE id = ${conversation.id} AND registration_id IS NOT NULL`;
    if (registration) {
      yield* lifecycleMetric(
        registration.id,
        "ending",
        conversation.personaID,
        [["initiator", initiator]],
        conversation.id,
      );
      yield* changeAlert(`greeting:${registration.id}`, false);
    }
  });
