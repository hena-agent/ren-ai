import { randomInt } from "node:crypto";
import { Clock, Data, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ContactEntry, SelectContacts, StartContact } from "@ren-ai/onboarding";
import type { PublicPersona } from "@ren-ai/onboarding";
import { withLifecycle } from "../conversations/lifecycle.ts";
import { claimPersona } from "./assignment.ts";
import { SelectionConflict, selectionKey, selectionChoices, chooseContact } from "./selection.ts";

class StartUnavailable extends Data.TaggedError("StartUnavailable") {}

export const contacts = (catalog: () => Promise<readonly PublicPersona[]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const loadProfiles = Effect.tryPromise({
      try: catalog,
      catch: () => new Error("Public Catalog unavailable"),
    });
    const snapshot = (profiles: readonly PublicPersona[]) =>
      Effect.gen(function* () {
        const entries = yield* sql<{
          id: string;
          handle: string;
          createdAt: number;
          state: typeof ContactEntry.Type.state | null;
          personaID: string | null;
          scheduledAt: number | null;
          requestId: string | null;
          unavailable: number;
          admitted: number;
          occupied: number;
          testHandle: number;
          endedAt: number | null;
          endingComplete: number | null;
          notification: typeof ContactEntry.Type.notification | null;
          imessageStatus: NonNullable<typeof ContactEntry.Type.imessage>["status"] | null;
          imessageCheckedAt: number | null;
        }>`SELECT r.id, r.handle, r.created_at AS createdAt, c.state, c.persona_id AS personaID,
      c.scheduled_at AS scheduledAt, c.request_id AS requestId, v.ended_at AS endedAt,
       EXISTS(SELECT 1 FROM ending_notification n WHERE n.conversation_id = v.id AND n.call_id = e.call_id || ':notice:' || e.notice_attempt AND n.state IN ('sent','delivered')) AS endingComplete,
      EXISTS(SELECT 1 FROM blocked WHERE handle = r.handle) OR EXISTS(SELECT 1 FROM removal WHERE handle = r.handle)
        OR EXISTS(SELECT 1 FROM reset WHERE handle = r.handle AND complete = 0) AS unavailable,
      EXISTS(SELECT 1 FROM user u WHERE u.handle = r.handle AND u.joined_at IS NOT NULL
        AND (EXISTS(SELECT 1 FROM conversation c WHERE c.user_id = u.id AND c.ended_at IS NULL)
          OR NOT EXISTS(SELECT 1 FROM conversation c WHERE c.user_id = u.id AND c.ended_at IS NOT NULL))) AS admitted,
      EXISTS(SELECT 1 FROM user u WHERE u.handle = r.handle AND (u.persona_id IS NOT NULL
        OR NOT EXISTS(SELECT 1 FROM conversation c WHERE c.user_id = u.id AND c.ended_at IS NOT NULL)))
        OR EXISTS(SELECT 1 FROM persona_assignment WHERE handle = r.handle) AS occupied,
      EXISTS(SELECT 1 FROM test_handle WHERE handle = r.handle) AS testHandle,
       n.state AS notification, r.imessage_status AS imessageStatus,
       r.imessage_checked_at AS imessageCheckedAt
      FROM discovery_registration r LEFT JOIN discovery_contact c ON c.registration_id = r.id
      LEFT JOIN discovery_notification n ON n.registration_id = r.id
      LEFT JOIN conversation v ON v.session_id = c.session_id LEFT JOIN conversation_end e ON e.conversation_id = v.id
      WHERE r.archived_at IS NULL ORDER BY r.created_at, r.id`;
        const likes = yield* sql<{
          registrationID: string;
          personaID: string;
        }>`SELECT l.registration_id AS registrationID, l.persona_id AS personaID FROM discovery_like l
          JOIN discovery_registration r ON r.id = l.registration_id WHERE r.archived_at IS NULL`;
        const taken = yield* sql<{ id: string }>`SELECT persona_id AS id FROM persona_assignment
      UNION SELECT COALESCE(conversation.persona_id, user.persona_id) FROM user
      LEFT JOIN conversation ON conversation.user_id = user.id`;
        const occupied = new Set(taken.map((row) => row.id));
        const byID = new Map(profiles.map((profile) => [profile.id, profile]));
        const byRegistration = new Map<string, (typeof likes)[number][]>();
        for (const like of likes) {
          const group = byRegistration.get(like.registrationID) ?? [];
          group.push(like);
          byRegistration.set(like.registrationID, group);
        }
        const available = new Set(profiles.map((p) => p.id).filter((id) => !occupied.has(id)));
        const result = entries.map((row) => {
          const likedPersonas = (byRegistration.get(row.id) ?? []).map((like) => ({
            id: like.personaID,
            name: byID.get(like.personaID)?.name ?? like.personaID,
          }));
          let reason: typeof ContactEntry.Type.reason = likedPersonas.some((p) =>
            available.has(p.id),
          )
            ? "ready"
            : "no_persona";
          if (row.imessageStatus !== "available") reason = "imessage_unverified";
          if (row.imessageStatus === "unavailable") reason = "no_imessage";
          if (row.state || row.occupied) reason = "reserved";
          if (row.admitted) reason = "active";
          if (row.unavailable) reason = "blocked";
          return {
            id: row.id,
            handle: row.handle,
            createdAt: row.createdAt,
            likedPersonas,
            assignablePersonas: likedPersonas.filter((p) => available.has(p.id)),
            state: row.state ?? (row.admitted ? "active" : "waiting"),
            eligible: reason === "ready",
            reason,
            persona: row.personaID
              ? {
                  id: row.personaID,
                  name: byID.get(row.personaID)?.name ?? row.personaID,
                }
              : null,
            scheduledAt: row.scheduledAt,
            requestId: row.requestId,
            testHandle: row.testHandle === 1,
            ...(row.notification && { notification: row.notification }),
            ...(row.imessageStatus && {
              imessage: { status: row.imessageStatus, checkedAt: row.imessageCheckedAt! },
            }),
            ...(row.endedAt !== null && {
              relationshipEnd: { at: row.endedAt, noticeDelivered: row.endingComplete === 1 },
            }),
          } satisfies typeof ContactEntry.Type;
        });
        return {
          entries: result,
          eligibleCount: result.filter((row) => row.eligible).length,
          available,
        };
      });
    const list = loadProfiles.pipe(
      Effect.flatMap(snapshot),
      Effect.map(({ entries, eligibleCount }) => ({ entries, eligibleCount })),
    );
    const recorded = (selectionID: string, key: string) =>
      Effect.gen(function* () {
        const [previous] = yield* sql<{
          input: string | null;
        }>`SELECT input FROM discovery_selection WHERE request_id = ${selectionID}`;
        if (previous && previous.input !== key)
          return yield* Effect.fail(new SelectionConflict("Selection request conflict"));
        return Boolean(previous);
      });
    const reserve = (
      row: typeof ContactEntry.Type,
      personaID: string,
      at: number,
      selectionID: string,
      requestId: string,
    ) =>
      Effect.gen(function* () {
        if (
          !(yield* claimPersona(personaID, row.handle).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ))
        )
          return false;
        yield* sql`INSERT INTO discovery_contact
          (registration_id, selection_id, persona_id, scheduled_at, state, request_id)
          VALUES (${row.id}, ${selectionID}, ${personaID}, ${at}, 'scheduled', ${requestId})`;
        return true;
      });
    const outcome = (selectionID: string, requested: number, profiles: readonly PublicPersona[]) =>
      Effect.gen(function* () {
        const selected = yield* sql<{
          id: string;
        }>`SELECT registration_id AS id FROM discovery_contact WHERE selection_id = ${selectionID}`;
        const { entries } = yield* snapshot(profiles);
        const ids = new Set(selected.map((row) => row.id));
        return {
          requestId: selectionID,
          requested,
          entries: entries.filter((row) => ids.has(row.id)),
        };
      });
    const select = (input: typeof SelectContacts.Type, requestId: string) =>
      Effect.flatMap(loadProfiles, (profiles) =>
        Effect.gen(function* () {
          const decoded = Schema.decodeUnknownSync(SelectContacts)(input);
          const key = selectionKey(decoded);
          const previous = yield* recorded(decoded.requestId, key);
          if (!previous) {
            const now = yield* Clock.currentTimeMillis;
            const { entries, available } = yield* snapshot(profiles);
            const choices = yield* selectionChoices(decoded, entries, available);
            const waiting = entries.filter(
              (row) =>
                row.eligible &&
                (!decoded.registrationIDs || decoded.registrationIDs.includes(row.id)),
            );
            yield* sql`INSERT INTO discovery_selection (request_id, requested, created_at, input) VALUES (${decoded.requestId}, ${decoded.count}, ${now}, ${key})`;
            let count = 0;
            while (waiting.length && count < decoded.count) {
              const chosen = chooseContact(waiting, available, choices);
              if (!chosen) continue;
              const { row, persona } = chosen;
              const at = now + randomInt(300_000, 3_600_001);
              if (!(yield* reserve(row, persona.id, at, decoded.requestId, requestId))) {
                if (choices.has(row.id))
                  return yield* Effect.fail(
                    new SelectionConflict("Chosen persona is no longer available"),
                  );
                continue;
              }
              available.delete(persona.id);
              count++;
            }
          }
          return yield* outcome(decoded.requestId, decoded.count, profiles);
        }).pipe(sql.withTransaction, withLifecycle),
      );
    /** A waiting test handle skips random Selection and its delay; null when it cannot start. */
    const start = (input: typeof StartContact.Type, requestId: string) =>
      Effect.flatMap(loadProfiles, (profiles) =>
        Effect.gen(function* () {
          const decoded = Schema.decodeUnknownSync(StartContact)(input);
          const key = JSON.stringify({
            registrationID: decoded.registrationID,
            personaID: decoded.personaID,
          });
          const previous = yield* recorded(decoded.requestId, key);
          if (!previous) {
            const now = yield* Clock.currentTimeMillis;
            const { entries, available } = yield* snapshot(profiles);
            const row = entries.find((entry) => entry.id === decoded.registrationID);
            if (
              !row?.testHandle ||
              !row.eligible ||
              !available.has(decoded.personaID) ||
              !row.likedPersonas.some((p) => p.id === decoded.personaID)
            )
              return yield* Effect.fail(new StartUnavailable());
            yield* sql`INSERT INTO discovery_selection (request_id, requested, created_at, input) VALUES (${decoded.requestId}, 1, ${now}, ${key})`;
            if (!(yield* reserve(row, decoded.personaID, now, decoded.requestId, requestId)))
              return yield* Effect.fail(new StartUnavailable());
          }
          return yield* outcome(decoded.requestId, 1, profiles);
        }).pipe(
          sql.withTransaction,
          withLifecycle,
          Effect.catchIf(
            (error) => error instanceof StartUnavailable,
            () => Effect.succeed(null),
          ),
        ),
      );
    return { list, select, start };
  });
