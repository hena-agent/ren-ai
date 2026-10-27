import { Clock, Effect } from "effect";
import { randomUUID } from "node:crypto";
import { SqlClient } from "effect/unstable/sql";
import type { remoteMessages } from "@ren-ai/imsg/client";
import type { DiscoveryRequest } from "@ren-ai/onboarding";
import { scheduleWork } from "../scheduling.ts";
import {
  contactCause,
  contactLog,
  type ContactLog,
  type ContactDiagnostic,
} from "./diagnostics.ts";
import {
  activeNotificationText,
  invitationSelectedText,
  waitlistNotificationText,
} from "./notification-copy.ts";
import { checkAvailability } from "./availability.ts";
import { claimWork, workBatchSize } from "../work-budget.ts";
import type { PublicPersona } from "@ren-ai/onboarding";
import { contacts } from "./contacts.ts";

export const notificationSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE discovery_notification (
    registration_id TEXT PRIMARY KEY REFERENCES discovery_registration(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','sent','failed','uncertain','skipped')),
    guid TEXT
  )`;
  yield* sql`CREATE INDEX notification_queue ON discovery_notification(created_at, registration_id) WHERE state = 'queued'`;
  // Anonymous attempts survive registration deletion so Reset cannot bypass the cap.
  yield* sql`CREATE TABLE notification_attempt (at INTEGER NOT NULL)`;
});

export const notificationSubmissionsSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE discovery_notification RENAME TO previous_notification`;
  yield* sql`DROP INDEX notification_queue`;
  yield* sql`CREATE TABLE discovery_notification (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registration_id TEXT REFERENCES discovery_registration(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES user(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    locale TEXT NOT NULL CHECK(locale IN ('en','ko','ja')),
    consent_version TEXT NOT NULL,
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('waiting','active')),
    state TEXT NOT NULL CHECK(state IN ('queued','sent','failed','uncertain','skipped')),
    guid TEXT,
    CHECK(registration_id IS NOT NULL OR user_id IS NOT NULL)
  )`;
  yield* sql`INSERT INTO discovery_notification (registration_id, created_at, locale, consent_version, request_id, kind, state, guid)
    SELECT n.registration_id, n.created_at, r.locale, r.consent_version, n.registration_id, 'waiting', n.state, n.guid
    FROM previous_notification n JOIN discovery_registration r ON r.id = n.registration_id`;
  yield* sql`DROP TABLE previous_notification`;
  yield* sql`CREATE INDEX notification_queue ON discovery_notification(created_at, id) WHERE state = 'queued'`;
  yield* sql`CREATE INDEX notification_registration ON discovery_notification(registration_id, id DESC)`;
  yield* sql`CREATE INDEX notification_user ON discovery_notification(user_id)`;
});

/** Runs in the submission transaction, including repeat and already-active submissions. */
export const queueRegistrationNotification = (
  input: Pick<DiscoveryRequest, "handle" | "locale" | "privacyNoticeVersion">,
  kind: "waiting" | "active",
  requestId: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const createdAt = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO discovery_notification (registration_id, user_id, created_at, locale, consent_version, request_id, kind, state)
      VALUES ((SELECT id FROM discovery_registration WHERE handle = ${input.handle} AND archived_at IS NULL),
        (SELECT id FROM user WHERE handle = ${input.handle}), ${createdAt}, ${input.locale}, ${input.privacyNoticeVersion}, ${requestId}, ${kind}, 'queued')`;
    yield* scheduleWork("notifications", createdAt);
  });

type Transport = Pick<
  Effect.Success<ReturnType<typeof remoteMessages>>,
  "notify" | "notificationStatus" | "availability"
>;

export const waitlistNotifications = (
  transport: Transport,
  log: ContactLog = contactLog,
  catalog?: () => Promise<readonly PublicPersona[]>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const claim = (id: number | string, table: "discovery_notification" | "invitation_delivery") =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`DELETE FROM notification_attempt WHERE at <= ${now - 3_600_000}`;
        const [count] = yield* sql<{
          total: number;
        }>`SELECT COUNT(*) AS total FROM notification_attempt`;
        const state = count!.total >= 30 ? "skipped" : "uncertain";
        const claimed = yield* sql`UPDATE ${sql(table)} SET state = ${state}
        WHERE id = ${id} AND state = 'queued' RETURNING id`;
        if (!claimed.length || state === "skipped") return false;
        yield* sql`INSERT INTO notification_attempt (at) VALUES (${now})`;
        return true;
      }).pipe(sql.withTransaction);
    const tick = Effect.gen(function* () {
      const limit = Math.min(30, yield* workBatchSize);
      const queued = yield* sql<{
        id: number | string;
        source: "discovery_notification" | "invitation_delivery";
        registrationID: string | null;
        handle: string;
        locale: keyof typeof waitlistNotificationText;
        kind: "waiting" | "active";
        requestId: string;
        invitationText: string | null;
        createdAt: number;
      }>`SELECT * FROM (SELECT n.id, 'discovery_notification' AS source, n.registration_id AS registrationID, COALESCE(r.handle, u.handle) AS handle,
          n.locale, n.kind, n.request_id AS requestId, NULL AS invitationText, n.created_at AS createdAt FROM discovery_notification n
        LEFT JOIN discovery_registration r ON r.id = n.registration_id
        LEFT JOIN user u ON u.id = n.user_id
         WHERE n.state = 'queued' ORDER BY n.created_at, n.id LIMIT ${limit})
         UNION ALL SELECT * FROM (SELECT id, 'invitation_delivery' AS source, NULL AS registrationID, handle,
           locale, 'active' AS kind, request_id AS requestId, body AS invitationText, created_at AS createdAt
           FROM invitation_delivery WHERE state = 'queued' ORDER BY created_at, id LIMIT ${limit})
         ORDER BY createdAt, id LIMIT ${limit}`;
      for (const row of queued) {
        if (!(yield* claimWork)) break;
        const started = performance.now();
        const fields: Pick<ContactDiagnostic, "requestId" | "operation" | "operationId"> = {
          requestId: row.requestId,
          operation: "notification.send",
        };
        let stage = "notification.claim";
        let failed = false;
        yield* Effect.gen(function* () {
          stage = "recipient.availability";
          let availability: "available" | "unavailable" | "failed" | null | undefined;
          if (row.source === "invitation_delivery") {
            const result = yield* transport.availability(row.handle).pipe(
              Effect.timeout("10 seconds"),
              Effect.tapError(
                () =>
                  sql`UPDATE invitation_delivery SET state = 'failed' WHERE id = ${row.id} AND state = 'queued'`,
              ),
            );
            fields.operationId = result.requestId;
            availability = result.available ? "available" : "unavailable";
          } else if (row.registrationID !== null)
            availability = yield* checkAvailability(row.registrationID, transport, log);
          if (availability === "unavailable") {
            failed = true;
            log({
              ...fields,
              stage,
              code: "no_imessage",
              outcome: "failed",
              level: "warn",
              durationMs: performance.now() - started,
            });
            yield* sql`UPDATE ${sql(row.source)} SET state = 'failed'
              WHERE id = ${row.id} AND state = 'queued'`;
            return;
          }
          if (
            catalog &&
            row.registrationID &&
            availability === "available" &&
            typeof row.id === "number"
          ) {
            stage = "invitation.selection";
            const pending =
              yield* sql`SELECT 1 FROM invitation_submission s JOIN invitation i ON i.token = s.token
              WHERE s.registration_id = ${row.registrationID} AND i.used_count < i.max_uses
                AND NOT EXISTS (SELECT 1 FROM discovery_contact WHERE registration_id = s.registration_id)`;
            if (pending.length) {
              const store = yield* contacts(catalog);
              yield* store.select(
                { requestId: randomUUID(), count: 1, registrationIDs: [row.registrationID] },
                row.requestId,
                row.id,
              );
            }
          }
          const selected = yield* sql`SELECT 1 FROM invitation_submission s
            JOIN discovery_registration r ON r.id = s.registration_id
            JOIN invitation_redemption i ON i.token = s.token AND i.handle = r.handle
            JOIN discovery_contact c ON c.registration_id = r.id
            WHERE s.registration_id = ${row.registrationID} AND s.selected_notification_id = ${row.id}`;
          stage = "notification.claim";
          if (!(yield* claim(row.id, row.source))) return;
          stage = "transport.send";
          const result = yield* transport
            .notify(
              row.handle,
              row.invitationText ??
                (selected.length > 0
                  ? invitationSelectedText
                  : row.kind === "active"
                    ? activeNotificationText
                    : waitlistNotificationText)[row.locale],
            )
            .pipe(Effect.timeout("30 seconds"));
          fields.operationId = result.requestId;
          stage = "notification.commit";
          yield* sql`UPDATE ${sql(row.source)} SET guid = ${result.guid} WHERE id = ${row.id}`;
          stage = "transport.status";
          const status = yield* transport
            .notificationStatus(result.guid)
            .pipe(Effect.timeout("5 seconds"));
          const state =
            status.state === "failed"
              ? "failed"
              : status.state === "pending"
                ? "uncertain"
                : "sent";
          failed = state === "failed";
          stage = "notification.commit";
          yield* sql`UPDATE ${sql(row.source)} SET state = ${state} WHERE id = ${row.id}`;
          if (failed)
            log({
              ...fields,
              stage: "transport.status",
              outcome: "failed",
              level: "error",
              code: `IMSG_SEND_${status.error}`,
              durationMs: performance.now() - started,
            });
        }).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              failed = true;
              log({
                ...fields,
                stage,
                outcome: "failed",
                level: "error",
                durationMs: performance.now() - started,
                ...contactCause(cause),
              });
            }),
          ),
        );
        log({
          ...fields,
          stage: "complete",
          outcome: failed ? "failed" : "completed",
          level: "info",
          durationMs: performance.now() - started,
        });
      }
      const remaining = yield* sql`SELECT 1 FROM discovery_notification WHERE state = 'queued'
          UNION ALL SELECT 1 FROM invitation_delivery WHERE state = 'queued' LIMIT 1`;
      if (remaining.length)
        yield* scheduleWork("notifications", (yield* Clock.currentTimeMillis) + 1_000);
    });
    return { tick };
  });
