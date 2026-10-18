import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { decodePersona, type PersonaRecord } from "@ren-ai/personas";

type Snapshot = { revision: string; personas: Map<string, PersonaRecord> };
const decode = (text: string) => {
  try {
    const rows = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(
      text,
    );
    return new Map(
      rows.map((row) => {
        const persona = decodePersona(row);
        return [persona.id, persona];
      }),
    );
  } catch (cause) {
    throw Object.assign(new Error("Invalid persisted Catalog", { cause }), {
      code: "CATALOG_CACHE_INVALID",
    });
  }
};

export const cachedCatalog = (load: () => Promise<Snapshot>, groundRules: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rules = createHash("sha256").update(groundRules).digest("hex");
    const fresh = Effect.gen(function* () {
      const snapshot = yield* Effect.tryPromise(load);
      const [existing] = yield* sql<{
        payload: string;
      }>`SELECT payload FROM runtime_catalog WHERE revision = ${snapshot.revision}`;
      if (existing) return { revision: snapshot.revision, personas: decode(existing.payload) };
      yield* sql`INSERT INTO runtime_catalog (id, revision, payload) VALUES (1, ${snapshot.revision}, ${JSON.stringify([...snapshot.personas.values()])})
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, payload = excluded.payload WHERE revision != excluded.revision`;
      return snapshot;
    });
    const current = Effect.gen(function* () {
      const [row] = yield* sql<{
        revision: string;
        payload: string;
      }>`SELECT revision, payload FROM runtime_catalog WHERE id = 1`;
      return row ? { revision: row.revision, personas: decode(row.payload) } : yield* fresh;
    });
    const synchronize = <E, R>(
      snapshot: Snapshot,
      run: Effect.Effect<void, E, R>,
      reconcile = false,
    ) =>
      Effect.gen(function* () {
        const { revision, personas } = snapshot;
        const key = `${revision}:${rules}`;
        const [row] = yield* sql<{
          synced: string | null;
        }>`SELECT synced FROM runtime_catalog WHERE id = 1`;
        if (row?.synced === key && !reconcile) return;
        yield* run;
        yield* sql`UPDATE runtime_catalog SET synced = ${key}, payload = ${JSON.stringify([...personas.values()])} WHERE id = 1 AND revision = ${revision}`;
      });
    return { current, fresh, synchronize };
  });
