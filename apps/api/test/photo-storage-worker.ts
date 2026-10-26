import { DurableObject } from "cloudflare:workers";
import type { DurableObjectStorage, SqlStorageValue } from "@cloudflare/workers-types";
import { SqliteClient } from "@effect/sql-sqlite-do";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { storageMeter } from "./storage-meter.test-helper.ts";
import { migrate } from "../src/database.ts";
import { photoStore } from "../src/photos/store.ts";

const conversation = { id: 1, handle: "fixture", sessionID: "fixture", personaID: "fixture" };

const probe = (storage: DurableObjectStorage, path: string) =>
  Effect.gen(function* () {
    yield* migrate;
    const sql = yield* SqlClient.SqlClient;
    const deleted: string[] = [];
    const bucket = {
      get: async () => null,
      put: async () => ({}),
      delete: async (key: string) => {
        deleted.push(key);
      },
    };
    const photos = yield* photoStore(bucket);
    if (path === "/setup") {
      yield* sql`INSERT INTO user(id,handle,locale,consent_version,consent_language,consent_at) VALUES(1,'fixture','en','v1','en',0)`;
      yield* sql`INSERT INTO conversation(id,user_id,persona_id,session_id,started_at) VALUES(1,1,'fixture','fixture',0)`;
      return { ready: true };
    }
    if (path === "/concurrent") {
      const replacement = yield* photoStore(bucket);
      const admitted = yield* Effect.all(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 ? photos : replacement).reserve(conversation, `call-${i}`, `photo-${i}`, true),
        ),
        { concurrency: "unbounded" },
      );
      const receipts = yield* sql<{
        id: string;
      }>`SELECT id FROM conversation_photo WHERE state = 'pending'`;
      for (const { id } of receipts) yield* photos.finish(conversation, id);
      return { admitted: admitted.filter(Boolean).length, total: receipts.length };
    }
    if (path === "/race") {
      yield* sql`INSERT INTO send(handle,conversation_id,kind,content,state,recorded_at,updated_at)
      VALUES('fixture',1,'photo','photo-0','sent',0,0)`;
      yield* sql`UPDATE photo_object SET due = 0 WHERE photo_id = 'photo-0'`;
      const exec = storage.sql.exec.bind(storage.sql);
      let raced = false;
      storage.sql.exec = <T extends Record<string, SqlStorageValue>>(
        query: string,
        ...bindings: SqlStorageValue[]
      ) => {
        if (!raced && query.includes("UPDATE photo_object SET due")) {
          raced = true;
          exec("DELETE FROM conversation_photo WHERE id = 'photo-0'");
        }
        return exec<T>(query, ...bindings);
      };
      try {
        yield* photos.cleanup();
        return {
          raced,
          deleted,
          remaining: yield* sql`SELECT * FROM photo_object WHERE photo_id = 'photo-0'`,
        };
      } finally {
        storage.sql.exec = exec;
      }
    }
    if (path === "/small" || path === "/large") {
      const size = path === "/small" ? 100 : 10_000;
      yield* sql`WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM history WHERE n < ${size})
      INSERT INTO conversation_photo(id,conversation_id,session_id,call_id,state,reserved_at,taken_at,expires_at,includes_me)
      SELECT ${path} || n,1,'history',${path} || n,CASE WHEN n % 2 = 0 THEN 'taken' ELSE 'pending' END,0,0,1,1 FROM history`;
      yield* sql`INSERT INTO photo_object SELECT id,NULL FROM conversation_photo WHERE session_id = 'history' AND state = 'taken' ON CONFLICT DO NOTHING`;
    }
    if (path === "/batch") {
      yield* sql`WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM history WHERE n < 75)
      INSERT INTO photo_object SELECT 'orphan-' || n,0 FROM history`;
    }
    const meter = storageMeter(storage);
    try {
      const replacement = yield* photoStore(bucket);
      const cleanups = yield* Effect.all([replacement.cleanup(), photos.cleanup()], {
        concurrency: "unbounded",
      });
      const next = yield* photos.nextCleanup();
      yield* replacement.nextCleanup();
      const idle = meter.totals();
      meter.reset();
      const now = yield* Clock.currentTimeMillis;
      const duplicate = yield* replacement.reserve(conversation, "call-0", "duplicate", true);
      const limited = yield* replacement.reserve(
        conversation,
        `${path}-limited`,
        `${path}-limited`,
        true,
      );
      const receipt = yield* replacement.receipt(conversation, "call-0");
      const quota = meter.totals();
      return {
        idle,
        quota,
        duplicate,
        limited,
        receipt,
        next,
        cleanups,
        deleted,
        plans: [
          ...storage.sql
            .exec(
              "EXPLAIN QUERY PLAN SELECT photo_id FROM photo_object WHERE due IS NOT NULL AND due <= ? ORDER BY due,photo_id LIMIT 50",
              now,
            )
            .toArray(),
          ...storage.sql
            .exec(
              "EXPLAIN QUERY PLAN SELECT 1 FROM conversation_photo WHERE conversation_id = 1 AND state = 'taken' AND taken_at > ? LIMIT 3",
              now - 86_400_000,
            )
            .toArray(),
          ...storage.sql
            .exec(
              "EXPLAIN QUERY PLAN SELECT 1 FROM conversation_photo WHERE conversation_id = 1 AND state = 'pending' AND reserved_at > ? LIMIT 3",
              now - 120_000,
            )
            .toArray(),
        ],
      };
    } finally {
      meter.restore();
    }
  });

interface Environment {
  PHOTOS: {
    idFromName: (name: string) => string;
    get: (id: string) => { fetch: (request: Request) => Promise<Response> };
  };
}
export class PhotoLedger extends DurableObject<Environment> {
  override async fetch(request: Request) {
    const result = await Effect.runPromise(
      Effect.scoped(probe(this.ctx.storage, new URL(request.url).pathname)).pipe(
        Effect.provide(SqliteClient.layer({ storage: this.ctx.storage })),
      ),
    );
    return Response.json(result);
  }
}
export default {
  fetch(request: Request, env: Environment) {
    return env.PHOTOS.get(env.PHOTOS.idFromName("ledger")).fetch(request);
  },
};
