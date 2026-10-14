import { Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { catalog, catalogAPI, catalogDatabase, profile } from "./catalog.test-helper.ts";

test("the public catalog exposes only published profiles and reflects live edits", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const personas = catalog();
        const api = yield* catalogAPI(personas);
        expect(yield* api.list()).toEqual([
          { id: "Persona1", name: "수아", bio: "24살 대학생", imageUrl: "" },
          { id: "harin", name: "하린", bio: "24살 대학생", imageUrl: "" },
        ]);
        personas.set("harin", { ...personas.get("harin")!, published: false });
        personas.set("Persona1", { ...personas.get("Persona1")!, name: "수아 수정" });
        expect(yield* api.list()).toEqual([
          { id: "Persona1", name: "수아 수정", bio: "24살 대학생", imageUrl: "" },
        ]);
        expect(yield* api.submit("draft@example.com", "draft")).toBe("persona_unavailable");
        expect(yield* api.submit("missing@example.com", "missing")).toBe("persona_unavailable");
        expect(api.fake.bubbles).toEqual([]);
        expect(api.sessions).toEqual([]);
      }),
    ).pipe(Effect.provide(catalogDatabase)),
  );
});

test("a missing or unpublished configured default cannot start new onboarding", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const personas = catalog();
        const api = yield* catalogAPI(personas);
        personas.set("Persona1", { ...profile, published: false });
        expect(yield* api.submit("unpublished@example.com")).toBe("persona_unavailable");
        personas.delete("Persona1");
        expect(yield* api.submit("missing@example.com")).toBe("persona_unavailable");
        expect(api.fake.bubbles).toEqual([]);
      }),
    ).pipe(Effect.provide(catalogDatabase)),
  );
});

test("a restored pending selection waits for its missing definition instead of changing persona", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const personas = catalog();
        const harin = personas.get("harin")!;
        personas.delete("harin");
        const api = yield* catalogAPI(personas);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, persona_id)
      VALUES ('waiting@example.com', 'ko', 'v1', 'ko', 1, 'harin')`;
        yield* sql`INSERT INTO send (handle, kind, content, state, recorded_at, updated_at)
      VALUES ('waiting@example.com', 'notice', 'recorded before crash', 'recorded', 1, 1)`;
        api.fake.statuses.set("waiting@example.com", "sent");
        yield* api.api.resume;
        yield* Effect.sleep("40 millis");
        expect(yield* api.submit("waiting@example.com", "Persona1")).toBe("persona_unavailable");
        expect(api.sessions).toEqual([]);
        expect(api.fake.bubbles).toEqual([]);
        personas.set("harin", harin);
        yield* Effect.sleep("300 millis");
        expect(yield* api.submit("waiting@example.com", "Persona1")).toBe("sent");
        expect(api.sessions).toEqual(["harin"]);
      }),
    ).pipe(Effect.provide(catalogDatabase)),
  );
});

test("HTTP onboarding chooses a published persona for life and omitted selection uses the configured default", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* catalogAPI(catalog(), "harin");
        expect(yield* api.submit("selected@example.com", "Persona1")).toBe("sent");
        expect(api.sessions).toEqual(["Persona1"]);
        expect(api.prompts[0]).toContain("수아의 인사");
        expect(yield* api.submit("selected@example.com", "harin")).toBe("sent");
        expect(yield* api.submit("selected@example.com", "missing")).toBe("sent");
        expect(api.sessions).toEqual(["Persona1"]);
        expect(api.fake.bubbles).toHaveLength(1);
        expect(yield* api.submit("default@example.com")).toBe("sent");
        expect(api.sessions).toEqual(["Persona1", "harin"]);
        expect(api.prompts[1]).toContain("하린의 인사");
      }),
    ).pipe(Effect.provide(catalogDatabase)),
  );
});

test("pending HTTP onboarding retains its selection when retried after an old notice fails", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* catalogAPI(catalog());
        const sql = yield* SqlClient.SqlClient;
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, persona_id)
      VALUES ('pending@example.com', 'ko', 'v1', 'ko', 1, 'harin')`;
        yield* sql`INSERT INTO send (handle, kind, content, state, recorded_at, updated_at)
      VALUES ('pending@example.com', 'notice', 'old notice', 'uncertain', ${now - 7 * 86_400_000}, 1)`;
        api.fake.messages.textStatus = (_, since) =>
          Effect.succeed(since < now ? "no_imessage" : "sent");
        expect(yield* api.submit("pending@example.com", "Persona1")).toBe("sent");
        expect(api.sessions).toEqual(["harin"]);
        expect(api.prompts[0]).toContain("하린의 인사");
      }),
    ).pipe(Effect.provide(catalogDatabase)),
  );
});
