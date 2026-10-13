import { randomInt } from "node:crypto";
import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ContactEntry, SelectContacts } from "@ren-ai/onboarding";
import type { PublicPersona } from "@ren-ai/onboarding";
import { withLifecycle } from "../conversations/lifecycle.ts";
import { claimPersona } from "./assignment.ts";

export const contacts = (catalog: () => Promise<readonly PublicPersona[]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const snapshot = Effect.gen(function* () {
      const profiles = yield* Effect.tryPromise({
        try: catalog,
        catch: () => new Error("Public Catalog unavailable"),
      });
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
      }>`SELECT r.id, r.handle, r.created_at AS createdAt, c.state, c.persona_id AS personaID,
      c.scheduled_at AS scheduledAt, c.request_id AS requestId,
      EXISTS(SELECT 1 FROM blocked WHERE handle = r.handle) OR EXISTS(SELECT 1 FROM removal WHERE handle = r.handle)
        OR EXISTS(SELECT 1 FROM reset WHERE handle = r.handle AND complete = 0) AS unavailable,
      EXISTS(SELECT 1 FROM user WHERE handle = r.handle AND joined_at IS NOT NULL) AS admitted,
      EXISTS(SELECT 1 FROM user WHERE handle = r.handle) OR EXISTS(SELECT 1 FROM persona_assignment WHERE handle = r.handle) AS occupied
      FROM discovery_registration r LEFT JOIN discovery_contact c ON c.registration_id = r.id ORDER BY r.created_at, r.id`;
      const likes = yield* sql<{
        registrationID: string;
        personaID: string;
      }>`SELECT registration_id AS registrationID, persona_id AS personaID FROM discovery_like`;
      const taken = yield* sql<{ id: string }>`SELECT persona_id AS id FROM persona_assignment
      UNION SELECT COALESCE(conversation.persona_id, user.persona_id) FROM user
      LEFT JOIN conversation ON conversation.user_id = user.id`;
      const available = new Set(
        profiles.map((p) => p.id).filter((id) => !taken.some((p) => p.id === id)),
      );
      const result = entries.map((row) => {
        const likedPersonas = likes
          .filter((like) => like.registrationID === row.id)
          .map((like) => ({
            id: like.personaID,
            name: profiles.find((p) => p.id === like.personaID)?.name ?? like.personaID,
          }));
        const reason = row.unavailable
          ? "blocked"
          : row.admitted
            ? "active"
            : row.state || row.occupied
              ? "reserved"
              : likedPersonas.some((p) => available.has(p.id))
                ? "ready"
                : "no_persona";
        return {
          id: row.id,
          handle: row.handle,
          createdAt: row.createdAt,
          likedPersonas,
          state: row.state ?? (row.admitted ? "active" : "waiting"),
          eligible: reason === "ready",
          reason,
          persona: row.personaID
            ? {
                id: row.personaID,
                name: profiles.find((p) => p.id === row.personaID)?.name ?? row.personaID,
              }
            : null,
          scheduledAt: row.scheduledAt,
          requestId: row.requestId,
        } satisfies typeof ContactEntry.Type;
      });
      return {
        entries: result,
        eligibleCount: result.filter((row) => row.eligible).length,
        available,
      };
    });
    const list = Effect.map(snapshot, ({ entries, eligibleCount }) => ({ entries, eligibleCount }));
    const select = (input: typeof SelectContacts.Type, requestId: string) =>
      Effect.gen(function* () {
        const decoded = Schema.decodeUnknownSync(SelectContacts)(input);
        const [previous] = yield* sql<{
          requested: number;
        }>`SELECT requested FROM discovery_selection WHERE request_id = ${decoded.requestId}`;
        if (previous && previous.requested !== decoded.count)
          return yield* Effect.fail(new Error("Selection request conflict"));
        if (!previous) {
          const now = yield* Clock.currentTimeMillis;
          const { entries, available } = yield* snapshot;
          const waiting = entries.filter((row) => row.eligible);
          yield* sql`INSERT INTO discovery_selection VALUES (${decoded.requestId}, ${decoded.count}, ${now})`;
          let count = 0;
          while (waiting.length && count < decoded.count) {
            const row = waiting.splice(randomInt(waiting.length), 1)[0]!;
            const candidates = row.likedPersonas.filter((p) => available.has(p.id));
            if (!candidates.length) continue;
            const persona = candidates[randomInt(candidates.length)]!;
            if (
              !(yield* claimPersona(persona.id, row.handle).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              ))
            )
              continue;
            available.delete(persona.id);
            const at = now + randomInt(300_000, 3_600_001);
            yield* sql`INSERT INTO discovery_contact
          (registration_id, selection_id, persona_id, scheduled_at, state, request_id)
          VALUES (${row.id}, ${decoded.requestId}, ${persona.id}, ${at}, 'scheduled', ${requestId})`;
            count++;
          }
        }
        const selected = yield* sql<{
          id: string;
        }>`SELECT registration_id AS id FROM discovery_contact WHERE selection_id = ${decoded.requestId}`;
        const { entries } = yield* list;
        return {
          requestId: decoded.requestId,
          requested: decoded.count,
          entries: entries.filter((row) => selected.some((p) => p.id === row.id)),
        };
      }).pipe(sql.withTransaction, withLifecycle);
    return { list, select };
  });
