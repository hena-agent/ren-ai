import { randomBytes } from "node:crypto";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { scheduleWork } from "../scheduling.ts";
import { SelectionConflict } from "./selection.ts";

export const invitationSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE invitation_settings (id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)))`;
  // Keep the receipt independently of a registration or Conversation: reselection never grants again.
  yield* sql`CREATE TABLE invitation_grant (handle TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`;
  yield* sql`INSERT INTO invitation_grant SELECT r.handle, MIN(s.created_at)
    FROM discovery_contact c JOIN discovery_registration r ON r.id = c.registration_id
    JOIN discovery_selection s ON s.request_id = c.selection_id GROUP BY r.handle`;
  yield* sql`INSERT OR IGNORE INTO invitation_grant SELECT handle, joined_at FROM user WHERE joined_at IS NOT NULL`;
  yield* sql`CREATE TABLE invitation (token TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES invitation_grant(handle),
    redeemed_by TEXT UNIQUE, redeemed_at INTEGER, CHECK((redeemed_by IS NULL) = (redeemed_at IS NULL)))`;
  yield* sql`CREATE INDEX invitation_owner ON invitation(owner)`;
  yield* sql`CREATE TABLE invitation_submission (registration_id TEXT PRIMARY KEY REFERENCES discovery_registration(id) ON DELETE CASCADE,
    token TEXT NOT NULL REFERENCES invitation(token), selected_notification_id INTEGER)`;
  yield* sql`ALTER TABLE discovery_notification ADD COLUMN invitation_text TEXT`;
});

const announcement = {
  ko: "Ren AI 초대장 2장이 도착했어요. 링크 하나로 친구 한 명을 초대할 수 있어요. 친구는 별도 선정 없이 연락 가능한 페르소나와 연결됩니다.",
  en: "You have 2 Ren AI invitations. Share one link with each friend to connect them with an available persona without waiting for selection.",
  ja: "Ren AIの招待状が2枚届きました。友だち1人につきリンクを1つ共有すると、選考を待たずに連絡可能なペルソナとつながれます。",
};

export const attachInvitation = (registrationID: string, token: string, handle: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const available =
      yield* sql`SELECT token FROM invitation WHERE token = ${token} AND owner != ${handle}
    AND (redeemed_by IS NULL OR redeemed_by = ${handle})`;
    if (!available.length) yield* Effect.fail("invitation" as const);
    yield* sql`INSERT INTO invitation_submission (registration_id, token) VALUES (${registrationID}, ${token})
      ON CONFLICT(registration_id) DO UPDATE SET token = excluded.token
      WHERE NOT EXISTS (SELECT 1 FROM discovery_contact WHERE registration_id = ${registrationID})`;
    // A fresh, consented submission is the explicit retry; idle queue checks never poll lookup failures.
    yield* sql`UPDATE discovery_registration SET imessage_status = NULL, imessage_checked_at = NULL
      WHERE id = ${registrationID} AND imessage_status IN ('failed','unavailable')
      AND NOT EXISTS (SELECT 1 FROM discovery_contact WHERE registration_id = ${registrationID})`;
  });

/** Consumed atomically with the reservation; the issuance switch never affects redemption. */
export const consumeInvitation = (registrationID: string, handle: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [pending] = yield* sql<{
      token: string;
    }>`SELECT token FROM invitation_submission WHERE registration_id = ${registrationID}`;
    if (!pending) return;
    const now = yield* Clock.currentTimeMillis;
    const updated = yield* sql`UPDATE invitation SET redeemed_by = ${handle}, redeemed_at = ${now}
    WHERE token = ${pending.token} AND redeemed_by IS NULL AND owner != ${handle} RETURNING token`;
    if (!updated.length)
      yield* Effect.fail(new SelectionConflict("Invitation is no longer available"));
  });

export const invitations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = Effect.gen(function* () {
    const [row] = yield* sql<{
      enabled: number;
    }>`SELECT enabled FROM invitation_settings WHERE id = 1`;
    return { enabled: row?.enabled === 1 };
  });
  const configure = (enabled: boolean) =>
    sql`INSERT INTO invitation_settings VALUES (1, ${Number(enabled)})
      ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled`.pipe(Effect.asVoid);
  const grant = (handle: string, requestId: string) =>
    Effect.gen(function* () {
      const { enabled } = yield* settings;
      const now = yield* Clock.currentTimeMillis;
      const inserted =
        yield* sql`INSERT OR IGNORE INTO invitation_grant VALUES (${handle}, ${now}) RETURNING handle`;
      if (!inserted.length || !enabled) return;
      const links: string[] = [];
      for (let i = 0; i < 2; i++) {
        const token = randomBytes(32).toString("hex");
        yield* sql`INSERT INTO invitation (token, owner) VALUES (${token}, ${handle})`;
        links.push(`https://renai.im/explore#invite=${token}`);
      }
      const [registration] = yield* sql<{
        id: string;
        locale: keyof typeof announcement;
        consentVersion: string;
      }>`SELECT id, locale, consent_version AS consentVersion FROM discovery_registration WHERE handle = ${handle} AND archived_at IS NULL`;
      const text = `${announcement[registration!.locale]}\n\n${links.join("\n\n")}`;
      yield* sql`INSERT INTO discovery_notification (registration_id, created_at, locale, consent_version, request_id, kind, state, invitation_text)
      VALUES (${registration!.id}, ${now}, ${registration!.locale}, ${registration!.consentVersion}, ${requestId}, 'active', 'queued', ${text})`;
      yield* scheduleWork("notifications", now).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    });
  const list = sql<{
    owner: string;
    token: string;
    redeemedAt: number | null;
  }>`SELECT i.owner, i.token, i.redeemed_at AS redeemedAt FROM invitation i
    JOIN discovery_registration r ON r.handle = i.owner WHERE r.archived_at IS NULL ORDER BY i.token`;
  return { settings, configure, grant, list };
});
