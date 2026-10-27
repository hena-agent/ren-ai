import { randomBytes, randomUUID } from "node:crypto";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { InvitationGrant, InvitationAccount, DiscoveryLocale } from "@ren-ai/onboarding";
import { scheduleWork } from "../scheduling.ts";
import { SelectionConflict } from "./selection.ts";

const announcement = {
  ko: "[Ren AI] 초대장이 도착했어요. 링크 하나로 한 명이 별도 선정 없이 연락 가능한 페르소나와 연결됩니다. 직접 사용하거나 친구에게 전달해 주세요. 이 주소는 안내 전용이라 답장을 확인하지 않습니다.",
  en: "[Ren AI] Your invitations are here. Each link connects one person with an available persona without waiting for selection. Use it yourself or share it with a friend. This address only sends notifications and doesn't read replies.",
  ja: "[Ren AI] 招待状が届きました。各リンクで1人が選考を待たずに連絡可能なペルソナとつながれます。自分で使うことも友だちに共有することもできます。このアドレスは通知専用で返信は確認していません。",
};

export const attachInvitation = (registrationID: string, token: string, handle: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const available = yield* sql`SELECT token FROM invitation WHERE token = ${token}
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
      WHERE token = ${pending.token} AND redeemed_by IS NULL RETURNING token`;
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
  const account = (handle: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{
        basic: number;
        extraCount: number;
      }>`SELECT basic_granted AS basic, extra_count AS extraCount FROM invitation_grant WHERE handle = ${handle}`;
      const issued = yield* sql<
        (typeof InvitationAccount.Type.invitations)[number]
      >`SELECT i.token, i.created_at AS createdAt, i.redeemed_at AS redeemedAt, d.kind, d.state
        FROM invitation i JOIN invitation_delivery d ON d.id = i.delivery_id
        WHERE i.owner = ${handle} ORDER BY i.created_at DESC, i.token LIMIT 50`;
      return {
        handle,
        basicGranted: row?.basic === 1,
        extraCount: row?.extraCount ?? 0,
        invitations: issued,
      };
    });
  const issue = (
    handle: string,
    kind: "basic" | "extra",
    locale: typeof DiscoveryLocale.Type,
    id: string,
    requestId: string,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT OR IGNORE INTO invitation_grant (handle, created_at) VALUES (${handle}, ${now})`;
      if (kind === "basic") {
        const claimed = yield* sql`UPDATE invitation_grant SET basic_granted = 1
          WHERE handle = ${handle} AND basic_granted = 0 RETURNING handle`;
        if (!claimed.length) return false;
      } else
        yield* sql`UPDATE invitation_grant SET extra_count = extra_count + 1 WHERE handle = ${handle}`;
      const tokens = Array.from({ length: kind === "basic" ? 2 : 1 }, () =>
        randomBytes(32).toString("hex"),
      );
      const body = `${announcement[locale]}\n\n${tokens.map((token) => `https://renai.im/explore#invite=${token}`).join("\n\n")}`;
      yield* sql`INSERT INTO invitation_delivery (id, handle, kind, locale, created_at, request_id, body, state)
        VALUES (${id}, ${handle}, ${kind}, ${locale}, ${now}, ${requestId}, ${body}, 'queued')`;
      for (const token of tokens)
        yield* sql`INSERT INTO invitation (token, owner, delivery_id, created_at) VALUES (${token}, ${handle}, ${id}, ${now})`;
      yield* scheduleWork("notifications", now).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      return true;
    });
  const grant = (handle: string, requestId: string) =>
    Effect.gen(function* () {
      const { enabled } = yield* settings;
      const now = yield* Clock.currentTimeMillis;
      const first = yield* sql`INSERT INTO invitation_grant (handle, created_at, automatic_seen)
        VALUES (${handle}, ${now}, 1) ON CONFLICT(handle) DO UPDATE SET automatic_seen = 1
        WHERE automatic_seen = 0 RETURNING handle`;
      if (!first.length || !enabled) return;
      const [registration] = yield* sql<{
        locale: typeof DiscoveryLocale.Type;
      }>`SELECT locale FROM discovery_registration WHERE handle = ${handle} AND archived_at IS NULL`;
      yield* issue(handle, "basic", registration!.locale, randomUUID(), requestId);
    });
  const manual = (input: typeof InvitationGrant.Type, requestId: string) =>
    Effect.gen(function* () {
      const [previous] = yield* sql<{
        handle: string;
        kind: string;
        locale: string;
      }>`SELECT handle, kind, locale FROM invitation_delivery WHERE id = ${input.requestId}`;
      if (previous) {
        if (
          previous.handle !== input.handle ||
          previous.kind !== input.kind ||
          previous.locale !== input.locale
        )
          return yield* Effect.fail(new SelectionConflict("Invitation request conflict"));
      } else {
        const blocked = yield* sql`SELECT 1 FROM blocked WHERE handle = ${input.handle}
          UNION SELECT 1 FROM removal WHERE handle = ${input.handle}`;
        if (blocked.length)
          return yield* Effect.fail(new SelectionConflict("Invitation recipient unavailable"));
        if (!(yield* issue(input.handle, input.kind, input.locale, input.requestId, requestId)))
          return yield* Effect.fail(new SelectionConflict("Basic invitations already granted"));
      }
      return yield* account(input.handle);
    }).pipe(sql.withTransaction);
  const list = sql<{
    owner: string;
    token: string;
    redeemedAt: number | null;
  }>`SELECT owner, token, redeemedAt FROM (
    SELECT i.owner, i.token, i.redeemed_at AS redeemedAt,
      ROW_NUMBER() OVER (PARTITION BY i.owner ORDER BY i.created_at DESC, i.token) AS position
    FROM invitation i JOIN discovery_registration r ON r.handle = i.owner WHERE r.archived_at IS NULL
  ) WHERE position <= 50 ORDER BY token`;
  return { settings, configure, grant, manual, account, list };
});
