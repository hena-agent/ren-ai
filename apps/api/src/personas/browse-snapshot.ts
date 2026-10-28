import { createHash } from "node:crypto";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { PublicPersona } from "@ren-ai/onboarding";

export const browseLifetime = 60 * 60 * 1000;
/** The served snapshot never expires; replacing it starts its cursors' remaining lifetime. */
const current = Number.MAX_SAFE_INTEGER;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function tier(persona: PublicPersona, locale: string) {
  if (persona.languages?.primary === locale) return 0;
  const level = persona.languages?.proficiency[locale];
  return level === "proficient" || level === "fluent" ? 1 : 2;
}

/** Shared immutable snapshots, never one 10,000-row shuffle per visitor. */
export const saveBrowseSnapshot = (
  profiles: readonly PublicPersona[],
  now: number,
  previous: string | null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ordered = profiles.toSorted((a, b) => a.id.localeCompare(b.id));
    const metadata = ordered.map((persona) => ({
      id: persona.id,
      ko: tier(persona, "ko"),
      en: tier(persona, "en"),
      ja: tier(persona, "ja"),
    }));
    const revision = hash(JSON.stringify(metadata));
    const [existing] =
      yield* sql`SELECT revision FROM browse_snapshot WHERE revision = ${revision} AND expires_at >= ${now}`;
    if (!existing) {
      yield* sql`INSERT OR REPLACE INTO browse_snapshot VALUES (${revision}, ${current})`;
      // Six bindings per row: 16 rows stay within SQLite Durable Objects' 100-parameter limit.
      for (let offset = 0; offset < metadata.length; offset += 16) {
        const rows = metadata.slice(offset, offset + 16).map((entry) => ({
          ...entry,
          revision,
          random_key: hash(entry.id),
        }));
        yield* sql`INSERT OR REPLACE INTO browse_persona ${sql.insert(rows)}`;
      }
    } else
      yield* sql`UPDATE browse_snapshot SET expires_at = ${current} WHERE revision = ${revision}`;
    // A cursor started on the replaced snapshot keeps its membership for its whole lifetime.
    if (previous !== null && previous !== revision)
      yield* sql`UPDATE browse_snapshot SET expires_at = ${now + browseLifetime}
        WHERE revision = ${previous} AND expires_at >= ${now}`;
    yield* sql`DELETE FROM browse_live WHERE id NOT IN (SELECT id FROM browse_persona WHERE revision = ${revision})`;
    for (let offset = 0; offset < ordered.length; offset += 50)
      yield* sql`INSERT INTO browse_live ${sql.insert(ordered.slice(offset, offset + 50).map((persona) => ({ id: persona.id, payload: JSON.stringify(persona) })))}
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload WHERE payload != excluded.payload`;
    return revision;
  });

/** Bounded maintenance: replaced snapshots are reclaimed only after their cursors expire. */
export const reclaimBrowseSnapshots = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`DELETE FROM browse_persona WHERE (revision, id) IN (
    SELECT p.revision, p.id FROM browse_snapshot s JOIN browse_persona p ON p.revision = s.revision
    WHERE s.expires_at < ${now} LIMIT 1000)`;
  yield* sql`DELETE FROM browse_snapshot WHERE revision IN (
    SELECT s.revision FROM browse_snapshot s WHERE s.expires_at < ${now}
    AND NOT EXISTS (SELECT 1 FROM browse_persona p WHERE p.revision = s.revision) LIMIT 100)`;
});
