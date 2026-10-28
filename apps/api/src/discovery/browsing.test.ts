import { Context, Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect, test } from "vitest";
import { BrowsePage, PersonaLink, PublicPersona } from "@ren-ai/onboarding";
import { withContactDatabase } from "./contact.test-helper.ts";
import { relationshipFixture } from "../../test/relationship.test-helper.ts";
import { makeDiscoveryWeb } from "./discovery.ts";
import type { ContactDiagnostic } from "./diagnostics.ts";

test("HTTP browsing pages, scoped profile restoration and sitemap links expose only public data", async () => {
  await withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const r = yield* relationshipFixture;
        yield* r.ending.end(r.conversation.sessionID, "private farewell", "ending");
        const [ending] = yield* r.sql<{ notice: string }>`SELECT notice FROM conversation_end`;
        const token = new URL(ending!.notice.split("\n").at(-1)!).hash.slice("#reselect=".length);
        const candidates = Array.from({ length: 25 }, (_, i) => ({
          id: i === 0 ? r.conversation.personaID : `p${i}`,
          name: `Public ${i}`,
          bio: "Public writing",
          imageUrl: "",
          privateDescription: "PRIVATE description",
          portraits: { anime: "https://images.test/anime.jpg" },
        }));
        const logs: ContactDiagnostic[] = [];
        const web = yield* makeDiscoveryWeb({
          catalog: async () => candidates,
          turnstileSecret: "secret",
          log: (event) => logs.push(event),
        });
        yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
        const verified = Context.make(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: true }))),
          ),
        );
        const send = (path: string, body?: object) =>
          Effect.promise(() =>
            web.handler(
              new Request(`https://api.test/discovery/${path}`, {
                ...(body && {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                }),
              }),
              verified,
            ),
          );
        const response = yield* send("personas?locale=ko");
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        const page = yield* Effect.promise(async () =>
          Schema.decodeUnknownSync(BrowsePage)(await response.json()),
        );
        expect(page.people).toHaveLength(10);
        const next = yield* send(`personas?locale=ko&cursor=${page.nextCursor!}`);
        expect(next.status).toBe(200);
        const lookup = yield* send("profiles", { ids: ["p24", "missing"] });
        const people = yield* Effect.promise(async () =>
          Schema.decodeUnknownSync(Schema.Array(PublicPersona))(await lookup.json()),
        );
        expect(people.map((p) => p.id)).toEqual(["p24"]);
        expect(JSON.stringify(people)).not.toContain("PRIVATE");
        const links = yield* send("persona-links");
        const listing = yield* Effect.promise(async () =>
          Schema.decodeUnknownSync(Schema.Array(PersonaLink))(await links.json()),
        );
        expect(listing).toHaveLength(25);
        expect(listing[0]!.imageUrl).toBe("https://images.test/anime.jpg");
        const restricted = yield* send("profiles", {
          ids: [r.conversation.personaID, "p24"],
          reselectionToken: token,
        });
        expect(yield* Effect.promise(() => restricted.json())).toEqual(people);
        const rejected = yield* send("profiles", {
          ids: ["p24"],
          reselectionToken: "a".repeat(64),
        });
        expect(rejected.status).toBe(400);
        expect(logs.at(-1)).toMatchObject({
          stage: "catalog.authorize",
          level: "warn",
          code: "reselection",
        });
        const invalid = yield* send("personas?locale=ko&cursor=PRIVATE");
        expect(invalid.status).toBe(400);
        expect(logs.at(-1)).toMatchObject({
          stage: "catalog.read",
          level: "warn",
          code: "personas",
        });
        expect(JSON.stringify(logs)).not.toContain(token);
        expect(JSON.stringify(logs)).not.toContain("PRIVATE");
        yield* r.sql`ALTER TABLE conversation_end RENAME TO unavailable_ending`;
        const unavailable = yield* send("profiles", { ids: ["p24"], reselectionToken: token });
        expect(unavailable.status).toBe(503);
        expect(logs.at(-1)).toMatchObject({
          stage: "catalog.authorize",
          level: "error",
          code: "storage",
          causeName: "UnknownError",
        });
      }),
    ),
  );
});
