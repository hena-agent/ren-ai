import { randomUUID } from "node:crypto";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { DiscoveryRequest, PublicPersona } from "@ren-ai/onboarding";
import { reselectionHash } from "../conversations/end.ts";
import { queueWaitlistNotification } from "./notifications.ts";

/** Called inside registration's transaction, after consent, Turnstile and catalog validation. */
export const reselect = (input: DiscoveryRequest) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (!input.reselectionToken) return yield* Effect.fail("reselection" as const);
    const [ending] = yield* sql<{
      id: number;
      consumedAt: number | null;
      registrationID: string | null;
    }>`
    SELECT e.conversation_id AS id, e.consumed_at AS consumedAt, e.registration_id AS registrationID
    FROM conversation_end e JOIN conversation c ON c.id = e.conversation_id
    JOIN user u ON u.id = c.user_id WHERE e.token_hash = ${reselectionHash(input.reselectionToken)}
    AND u.handle = ${input.handle}
    AND NOT EXISTS (SELECT 1 FROM conversation newer WHERE newer.user_id = u.id AND newer.id > c.id)`;
    if (!ending) return yield* Effect.fail("reselection" as const);
    if (ending.consumedAt !== null) {
      const current =
        yield* sql`SELECT 1 FROM discovery_registration WHERE id = ${ending.registrationID} AND handle = ${input.handle} AND archived_at IS NULL`;
      if (!current.length) return yield* Effect.fail("reselection" as const);
      return undefined;
    }
    const id = randomUUID();
    const now = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE discovery_registration SET archived_at = ${now} WHERE handle = ${input.handle} AND archived_at IS NULL`;
    yield* sql`INSERT INTO discovery_registration (id, handle, locale, consent_version, created_at, starting_relationship)
    VALUES (${id}, ${input.handle}, ${input.locale}, ${input.privacyNoticeVersion}, ${now}, ${input.startingRelationship ?? "dating"})`;
    yield* sql`INSERT INTO discovery_profile (registration_id, name, age, gender)
      VALUES (${id}, ${input.name ?? null}, ${input.age ?? null}, ${input.gender ?? null})`;
    yield* sql`INSERT INTO discovery_language VALUES (${id}, ${input.conversationLanguage ?? input.locale})`;
    for (const personaID of input.likedPersonaIDs)
      yield* sql`INSERT INTO discovery_like VALUES (${id}, ${personaID})`;
    yield* sql`UPDATE conversation_end SET consumed_at = ${now}, registration_id = ${id}, farewell_pending = 0, notice_pending = 0 WHERE conversation_id = ${ending.id}`;
    yield* queueWaitlistNotification(id, now);
    return undefined;
  });

/** Ended personas stay retired; their private relationship history is retained for the operator. */
export const withoutEndedPersonas = (profiles: readonly PublicPersona[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ended = yield* sql<{
      id: string;
    }>`SELECT DISTINCT persona_id AS id FROM conversation WHERE ended_at IS NOT NULL`;
    const retired = new Set(ended.map((row) => row.id));
    return profiles.filter((profile) => !retired.has(profile.id));
  });
