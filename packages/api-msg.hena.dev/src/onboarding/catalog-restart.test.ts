import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../database.ts";
import { catalog, catalogAPI } from "./catalog.test-helper.ts";

test("restoring a pending notice uses its saved persona even if she was unpublished while offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "selected-persona-restart-"));
  const filename = join(root, "state.sqlite");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, persona_id)
        VALUES ('restored@example.com', 'ko', 'v1', 'ko', 1, 'harin')`;
        yield* sql`INSERT INTO send (handle, kind, content, state, recorded_at, updated_at)
        VALUES ('restored@example.com', 'notice', 'notice before crash', 'uncertain', 1, 1)`;
      }).pipe(Effect.provide(SqliteClient.layer({ filename }))),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const personas = catalog();
          personas.set("harin", { ...personas.get("harin")!, published: false });
          const api = yield* catalogAPI(personas);
          api.fake.statuses.set("restored@example.com", "sent");
          yield* api.api.resume;
          yield* Effect.sleep("40 millis");
          expect(api.sessions).toEqual(["harin"]);
          expect(api.prompts[0]).toContain("하린의 인사");
          expect(yield* api.submit("restored@example.com", "Persona1")).toBe("sent");
          expect(api.sessions).toEqual(["harin"]);
          expect(api.fake.bubbles).toEqual([]);
          yield* api.api.resume;
          yield* Effect.sleep("40 millis");
          expect(api.prompts[1]).toContain("하린의 인사");
        }),
      ).pipe(Effect.provide(SqliteClient.layer({ filename }))),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
