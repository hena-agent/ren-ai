import { Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { remoteMessages } from "@ren-ai/imsg/client";
import { scheduleWork } from "../scheduling.ts";
import {
  contactCause,
  contactLog,
  type ContactLog,
  type ContactDiagnostic,
} from "./diagnostics.ts";
import { waitlistNotificationText } from "./notification-copy.ts";
import { checkAvailability } from "./availability.ts";

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

/** Runs in the registration transaction; failed commits cannot leave orphaned work. */
export const queueWaitlistNotification = (registrationID: string, createdAt: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO discovery_notification (registration_id, created_at, state)
      VALUES (${registrationID}, ${createdAt}, 'queued')`;
    yield* scheduleWork("notifications", createdAt);
  });

type Transport = Pick<
  Effect.Success<ReturnType<typeof remoteMessages>>,
  "notify" | "notificationStatus" | "availability"
>;

export const waitlistNotifications = (transport: Transport, log: ContactLog = contactLog) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const claim = (id: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`DELETE FROM notification_attempt WHERE at <= ${now - 3_600_000}`;
        const [count] = yield* sql<{
          total: number;
        }>`SELECT COUNT(*) AS total FROM notification_attempt`;
        const state = count!.total >= 30 ? "skipped" : "uncertain";
        const claimed = yield* sql`UPDATE discovery_notification SET state = ${state}
        WHERE registration_id = ${id} AND state = 'queued' RETURNING registration_id`;
        if (!claimed.length || state === "skipped") return false;
        yield* sql`INSERT INTO notification_attempt (at) VALUES (${now})`;
        return true;
      }).pipe(sql.withTransaction);
    const tick = Effect.gen(function* () {
      const queued = yield* sql<{
        id: string;
        handle: string;
        locale: keyof typeof waitlistNotificationText;
      }>`SELECT n.registration_id AS id, r.handle, r.locale FROM discovery_notification n
        JOIN discovery_registration r ON r.id = n.registration_id
         WHERE n.state = 'queued' ORDER BY n.created_at, n.registration_id LIMIT 30`;
      for (const row of queued) {
        const started = performance.now();
        const fields: Pick<ContactDiagnostic, "requestId" | "operation" | "operationId"> = {
          requestId: row.id,
          operation: "notification.send",
        };
        let stage = "notification.claim";
        let failed = false;
        yield* Effect.gen(function* () {
          stage = "recipient.availability";
          const availability = yield* checkAvailability(row.id, transport, log);
          if (availability === "unavailable") {
            yield* sql`UPDATE discovery_notification SET state = 'failed'
              WHERE registration_id = ${row.id} AND state = 'queued'`;
            return;
          }
          stage = "notification.claim";
          if (!(yield* claim(row.id))) return;
          stage = "transport.send";
          const result = yield* transport
            .notify(row.handle, waitlistNotificationText[row.locale])
            .pipe(Effect.timeout("30 seconds"));
          fields.operationId = result.requestId;
          stage = "notification.commit";
          yield* sql`UPDATE discovery_notification SET guid = ${result.guid} WHERE registration_id = ${row.id}`;
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
          yield* sql`UPDATE discovery_notification SET state = ${state} WHERE registration_id = ${row.id}`;
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
      const remaining =
        yield* sql`SELECT registration_id FROM discovery_notification WHERE state = 'queued' LIMIT 1`;
      if (remaining.length)
        yield* scheduleWork("notifications", (yield* Clock.currentTimeMillis) + 1_000);
    });
    return { tick };
  });
