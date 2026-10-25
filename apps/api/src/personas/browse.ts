import { randomBytes } from "node:crypto";
import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BrowseQuery, DiscoveryLocale, PublicPersona } from "@ren-ai/onboarding";
import { browseLifetime } from "./browse-snapshot.ts";

const hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Cursor = Schema.Struct({
  revision: hex,
  seed: hex,
  locale: DiscoveryLocale,
  tier: Schema.Literals([0, 1, 2]),
  segment: Schema.Literals([0, 1]),
  key: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{64})?$/)),
  id: Schema.String.check(Schema.isMaxLength(64)),
  expires: Schema.Number.check(Schema.isInt()),
});
type Cursor = typeof Cursor.Type;
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
const decode = (cursor: string) =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(Schema.fromJsonString(Cursor))(
        Buffer.from(cursor, "base64url").toString(),
      ),
    catch: () => "personas" as const,
  });
const profiles = (rows: readonly { payload: string }[]) =>
  Effect.try({
    try: () =>
      rows.map((row) =>
        Schema.decodeUnknownSync(Schema.fromJsonString(PublicPersona))(row.payload),
      ),
    catch: (cause) => new Error("Invalid stored public profile", { cause }),
  });
function readSegment(
  cursor: Cursor,
  tier: Cursor["tier"],
  segment: Cursor["segment"],
  limit: number,
  handle: string,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const continuing = tier === cursor.tier && segment === cursor.segment;
    const boundary = segment === 0 ? cursor.seed : "";
    const lower = continuing && cursor.key > boundary ? cursor.key : boundary;
    const upper = segment === 0 ? "g" : cursor.seed;
    const rows = yield* sql<{ id: string; payload: string; random_key: string }>`
      SELECT p.id, l.payload, p.random_key FROM browse_persona p JOIN browse_live l ON l.id = p.id
      WHERE p.revision = ${cursor.revision} AND p.${sql(cursor.locale)} = ${tier}
      AND p.random_key >= ${lower} AND p.random_key < ${upper}
      AND (p.random_key, p.id) > (${lower}, ${continuing ? cursor.id : ""})
      AND NOT EXISTS (SELECT 1 FROM persona_exclusion e WHERE e.handle = ${handle} AND e.persona_id = p.id)
      ORDER BY p.random_key, p.id LIMIT ${limit}`;
    return rows.map((row) => ({
      payload: row.payload,
      cursor: { ...cursor, tier, segment, key: row.random_key, id: row.id },
    }));
  });
}

export const browsePage = (query: BrowseQuery, revision: string, handle = "") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    const cursor: Cursor = query.cursor
      ? yield* decode(query.cursor)
      : {
          revision,
          seed: randomBytes(32).toString("hex"),
          locale: query.locale,
          tier: 0,
          segment: 0,
          key: "",
          id: "",
          expires: now + browseLifetime,
        };
    if (
      cursor.locale !== query.locale ||
      cursor.expires <= now ||
      cursor.expires > now + browseLifetime
    )
      return yield* Effect.fail("personas" as const);
    const [snapshot] =
      yield* sql`SELECT revision FROM browse_snapshot WHERE revision = ${cursor.revision} AND expires_at >= ${now}`;
    if (!snapshot) return yield* Effect.fail("personas" as const);
    const found: { payload: string; cursor: Cursor }[] = [];
    const segments = ([0, 1, 2] as const).flatMap((tier) =>
      ([0, 1] as const).map((segment) => ({ tier, segment })),
    );
    for (const { tier, segment } of segments) {
      if (tier * 2 + segment < cursor.tier * 2 + cursor.segment) continue;
      found.push(...(yield* readSegment(cursor, tier, segment, 11 - found.length, handle)));
      if (found.length === 11) break;
    }
    return {
      people: yield* profiles(found.slice(0, 10)),
      nextCursor: found.length > 10 ? encode(found[9]!.cursor) : null,
    };
  });

export const lookupProfiles = (ids: readonly string[], handle = "") =>
  Effect.gen(function* () {
    if (!ids.length) return [];
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ payload: string }>`SELECT p.payload FROM browse_live p
      WHERE p.id IN ${sql.in(ids)}
      AND NOT EXISTS (SELECT 1 FROM persona_exclusion e WHERE e.handle = ${handle} AND e.persona_id = p.id)`;
    return yield* profiles(rows);
  });
