import { randomBytes, randomUUID } from "node:crypto";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type {
  InvitationGrant,
  InvitationAccount,
  InvitationCreate,
  InvitationTicket,
  DiscoveryLocale,
} from "@ren-ai/onboarding";
import { scheduleWork } from "../scheduling.ts";
import { SelectionConflict } from "./selection.ts";

const announcement = {
  ko: "[RenAI] 초대장이 도착했어요. 별도 선정 없이 연락 가능한 페르소나와 연결됩니다. 직접 사용하거나 친구에게 전달해 주세요. 이 주소는 안내 전용이라 답장을 확인하지 않습니다.",
  en: "[RenAI] Your invitations are here. Connect with an available persona without waiting for selection. Use them yourself or share them with friends. This address only sends notifications and doesn't read replies.",
  ja: "[RenAI] 招待状が届きました。選考を待たずに連絡可能なペルソナとつながれます。自分で使うことも友だちに共有することもできます。このアドレスは通知専用で返信は確認していません。",
};

export const attachInvitation = (registrationID: string, token: string, handle: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const available = yield* sql<{
      token: string;
    }>`SELECT token FROM invitation WHERE token = ${token}
        AND (used_count < max_uses OR EXISTS (SELECT 1 FROM invitation_redemption WHERE handle = ${handle} AND token = invitation.token))`;
    if (!available.length) yield* Effect.fail("invitation" as const);
    yield* sql`INSERT INTO invitation_submission (registration_id, token) VALUES (${registrationID}, ${available[0]!.token})
      ON CONFLICT(registration_id) DO UPDATE SET token = excluded.token
      WHERE NOT EXISTS (SELECT 1 FROM discovery_contact WHERE registration_id = ${registrationID})`;
    // A fresh, consented submission is the explicit retry; idle queue checks never poll lookup failures.
    yield* sql`UPDATE discovery_registration SET imessage_status = NULL, imessage_checked_at = NULL, imessage_reason = NULL
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
    const updated =
      yield* sql`UPDATE invitation SET used_count = used_count + 1, redeemed_at = ${now}
      WHERE token = ${pending.token} AND used_count < max_uses RETURNING token`;
    if (!updated.length)
      yield* Effect.fail(new SelectionConflict("Invitation is no longer available"));
    yield* sql`INSERT INTO invitation_redemption (handle, token, redeemed_at) VALUES (${handle}, ${pending.token}, ${now})`;
  });

export const invitations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const codes = sql<
    typeof InvitationTicket.Type
  >`SELECT token, created_at AS createdAt, redeemed_at AS redeemedAt,
    max_uses AS maxUses, grant_count AS grantCount, used_count AS usedCount FROM invitation
    WHERE creation_id IS NOT NULL ORDER BY created_at DESC, token LIMIT 50`;
  const create = (input: typeof InvitationCreate.Type) =>
    Effect.gen(function* () {
      const [previous] = yield* sql<
        typeof InvitationTicket.Type
      >`SELECT token, created_at AS createdAt, redeemed_at AS redeemedAt,
      max_uses AS maxUses, grant_count AS grantCount, used_count AS usedCount FROM invitation WHERE creation_id = ${input.requestId}`;
      if (previous) {
        if (
          (input.code !== undefined && previous.token !== input.code) ||
          previous.maxUses !== input.maxUses ||
          previous.grantCount !== input.grantCount
        )
          return yield* Effect.fail(new SelectionConflict("Invitation request conflict"));
        return previous;
      }
      const token = input.code ?? randomBytes(32).toString("hex");
      const existing = yield* sql`SELECT 1 FROM invitation WHERE token = ${token}`;
      if (existing.length)
        return yield* Effect.fail(new SelectionConflict("Invitation code already exists"));
      const createdAt = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO invitation (token, created_at, max_uses, grant_count, creation_id)
      VALUES (${token}, ${createdAt}, ${input.maxUses}, ${input.grantCount}, ${input.requestId})`;
      return {
        token,
        createdAt,
        redeemedAt: null,
        maxUses: input.maxUses,
        grantCount: input.grantCount,
        usedCount: 0,
      };
    }).pipe(sql.withTransaction);
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
      >`SELECT i.token, i.created_at AS createdAt, i.redeemed_at AS redeemedAt, d.kind, d.state,
         i.max_uses AS maxUses, i.grant_count AS grantCount, i.used_count AS usedCount
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
    {
      handle,
      kind,
      locale,
      requestId: id,
      maxUses = 1,
      grantCount = 2,
    }: typeof InvitationGrant.Type,
    requestId: string,
    count = kind === "basic" ? 2 : 1,
    parentToken: string | null = null,
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
      const tokens = Array.from({ length: count }, () => randomBytes(32).toString("hex"));
      const limits = {
        ko: `각 코드 최대 ${maxUses}명 · 선정자에게 ${grantCount}개 지급. 새 코드도 이 설정을 상속합니다.`,
        en: `Each code admits up to ${maxUses} people and grants ${grantCount} new codes per selection. New codes inherit these settings.`,
        ja: `各コード最大${maxUses}人・選定者に${grantCount}個を発行。新しいコードにも同じ設定を引き継ぎます。`,
      };
      const body = `${announcement[locale]}\n\n${limits[locale]}\n\n${tokens.map((token) => `https://renai.im/explore#invite=${token}`).join("\n\n")}`;
      yield* sql`INSERT INTO invitation_delivery (id, handle, kind, locale, created_at, request_id, body, state, max_uses, grant_count)
        VALUES (${id}, ${handle}, ${kind}, ${locale}, ${now}, ${requestId}, ${body}, ${tokens.length ? "queued" : "skipped"}, ${maxUses}, ${grantCount})`;
      for (const token of tokens)
        yield* sql`INSERT INTO invitation (token, owner, delivery_id, created_at, max_uses, grant_count, parent_token)
          VALUES (${token}, ${handle}, ${id}, ${now}, ${maxUses}, ${grantCount}, ${parentToken})`;
      if (tokens.length)
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
        maxUses: number | null;
        grantCount: number | null;
        parentToken: string | null;
      }>`SELECT r.locale, i.max_uses AS maxUses, i.grant_count AS grantCount, i.token AS parentToken
        FROM discovery_registration r LEFT JOIN invitation_submission s ON s.registration_id = r.id
        LEFT JOIN invitation i ON i.token = s.token WHERE r.handle = ${handle} AND r.archived_at IS NULL`;
      yield* issue(
        {
          handle,
          kind: "basic",
          locale: registration!.locale,
          requestId: randomUUID(),
          maxUses: registration!.maxUses ?? 1,
          grantCount: registration!.grantCount ?? 2,
        },
        requestId,
        registration!.grantCount ?? 2,
        registration!.parentToken,
      );
    });
  const manual = (input: typeof InvitationGrant.Type, requestId: string) =>
    Effect.gen(function* () {
      const [previous] = yield* sql<{
        handle: string;
        kind: string;
        locale: string;
        maxUses: number;
        grantCount: number;
      }>`SELECT handle, kind, locale, max_uses AS maxUses, grant_count AS grantCount FROM invitation_delivery WHERE id = ${input.requestId}`;
      if (previous) {
        if (
          previous.handle !== input.handle ||
          previous.kind !== input.kind ||
          previous.locale !== input.locale ||
          previous.maxUses !== (input.maxUses ?? 1) ||
          previous.grantCount !== (input.grantCount ?? 2)
        )
          return yield* Effect.fail(new SelectionConflict("Invitation request conflict"));
      } else {
        const blocked = yield* sql`SELECT 1 FROM blocked WHERE handle = ${input.handle}
          UNION SELECT 1 FROM removal WHERE handle = ${input.handle}`;
        if (blocked.length)
          return yield* Effect.fail(new SelectionConflict("Invitation recipient unavailable"));
        if (!(yield* issue(input, requestId)))
          return yield* Effect.fail(new SelectionConflict("Basic invitations already granted"));
      }
      return yield* account(input.handle);
    }).pipe(sql.withTransaction);
  const list = sql<{
    owner: string;
    token: string;
    redeemedAt: number | null;
    maxUses: number;
    grantCount: number;
    usedCount: number;
  }>`SELECT owner, token, redeemedAt, maxUses, grantCount, usedCount FROM (
    SELECT i.owner, i.token, i.redeemed_at AS redeemedAt,
      i.max_uses AS maxUses, i.grant_count AS grantCount, i.used_count AS usedCount,
      ROW_NUMBER() OVER (PARTITION BY i.owner ORDER BY i.created_at DESC, i.token) AS position
    FROM invitation i JOIN discovery_registration r ON r.handle = i.owner WHERE r.archived_at IS NULL
  ) WHERE position <= 50 ORDER BY token`;
  return { settings, configure, grant, manual, account, list, create, codes };
});
