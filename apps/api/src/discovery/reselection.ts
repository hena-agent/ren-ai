import { randomUUID } from "node:crypto";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { DiscoveryRequest } from "@ren-ai/onboarding";
import { reselectionHash } from "../conversations/ending-record.ts";
import { contactCause, type ContactLog } from "./diagnostics.ts";
import { registrationMetric } from "../metrics/lifecycle.ts";

const reselectionAuthorization = (token: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [ending] = yield* sql<{
      id: number;
      handle: string;
      consumedAt: number | null;
      registrationID: string | null;
    }>`SELECT e.conversation_id AS id, u.handle, e.consumed_at AS consumedAt, e.registration_id AS registrationID
      FROM conversation_end e JOIN conversation c ON c.id = e.conversation_id
      JOIN user u ON u.id = c.user_id WHERE e.token_hash = ${reselectionHash(token)}
      AND NOT EXISTS (SELECT 1 FROM conversation newer WHERE newer.user_id = u.id AND newer.id > c.id)`;
    if (!ending) return yield* Effect.fail("reselection" as const);
    if (ending.consumedAt !== null) {
      const current =
        yield* sql`SELECT 1 FROM discovery_registration WHERE id = ${ending.registrationID} AND handle = ${ending.handle} AND archived_at IS NULL`;
      if (!current.length) return yield* Effect.fail("reselection" as const);
    }
    return ending;
  });

export const browsingHandle = (token: string, requestId: string, log: ContactLog) =>
  Effect.gen(function* () {
    const ending = yield* reselectionAuthorization(token);
    if (ending.consumedAt !== null) return yield* Effect.fail("reselection" as const);
    return ending.handle;
  }).pipe(
    Effect.tapError((cause) =>
      Effect.sync(() =>
        log({
          requestId,
          operation: "discovery.reselection",
          stage: "catalog.authorize",
          code: typeof cause === "string" ? cause : "storage",
          level: typeof cause === "string" ? "warn" : "error",
          outcome: "failed",
          durationMs: 0,
          ...(typeof cause !== "string" && contactCause(cause)),
        }),
      ),
    ),
    Effect.mapError((cause) => (typeof cause === "string" ? cause : ("storage" as const))),
  );

/** Called inside registration's transaction, after consent, Turnstile and catalog validation. */
export const reselect = (input: DiscoveryRequest, country: string | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (!input.reselectionToken) return yield* Effect.fail("reselection" as const);
    const ending = yield* reselectionAuthorization(input.reselectionToken);
    if (ending.handle !== input.handle) return yield* Effect.fail("reselection" as const);
    if (ending.consumedAt !== null) return undefined;
    const id = randomUUID();
    const now = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE discovery_registration SET archived_at = ${now} WHERE handle = ${input.handle} AND archived_at IS NULL`;
    yield* sql`INSERT INTO discovery_registration (id, handle, locale, consent_version, created_at, starting_relationship, image_style)
    VALUES (${id}, ${input.handle}, ${input.locale}, ${input.privacyNoticeVersion}, ${now}, ${input.startingRelationship ?? "dating"}, ${input.imageStyle ?? "anime"})`;
    yield* sql`INSERT INTO discovery_profile (registration_id, name, age, gender)
      VALUES (${id}, ${input.name}, ${input.age ?? null}, ${input.gender ?? null})`;
    yield* sql`INSERT INTO discovery_language VALUES (${id}, ${input.conversationLanguage ?? input.locale})`;
    for (const personaID of input.likedPersonaIDs)
      yield* sql`INSERT INTO discovery_like VALUES (${id}, ${personaID})`;
    yield* sql`UPDATE conversation_end SET consumed_at = ${now}, registration_id = ${id}, farewell_pending = 0, notice_pending = 0 WHERE conversation_id = ${ending.id}`;
    yield* registrationMetric(id, input, country, "reselection");
    return undefined;
  });

export const endedPersonaIDs = (handle: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ended = yield* sql<{
      id: string;
    }>`SELECT persona_id AS id FROM persona_exclusion WHERE handle = ${handle}`;
    return new Set(ended.map((row) => row.id));
  });
