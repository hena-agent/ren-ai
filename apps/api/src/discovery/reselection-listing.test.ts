import { randomUUID } from "node:crypto";
import { Context, Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect, test } from "vitest";
import { discoveryNotice } from "@ren-ai/onboarding";
import { relationshipFixture } from "../../test/relationship.test-helper.ts";
import { contactFixture, withContactDatabase } from "./contact.test-helper.ts";
import { makeDiscoveryWeb } from "./discovery.ts";

const verified = Context.make(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: true }))),
  ),
);

test("personas at capacity remain public and can be Liked while selection waits", async () => {
  await withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* contactFixture;
        for (let index = 0; index < 5; index++) yield* f.register(`full${index}@example.net`);
        yield* f.store.select({ requestId: randomUUID(), count: 5 }, "full");
        const web = yield* makeDiscoveryWeb({
          catalog: async () => f.profiles,
          turnstileSecret: "secret",
        });
        yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
        const publicList = yield* Effect.promise(() =>
          web.handler(new Request("https://api.test/discovery/personas"), verified),
        );
        expect(yield* Effect.promise(() => publicList.json())).toEqual(f.profiles);
        const joined = yield* Effect.promise(() =>
          web.handler(
            new Request("https://api.test/discovery/waitlist", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                handle: "+821066666666",
                locale: "ko",
                privacyNoticeVersion: discoveryNotice.version,
                likedPersonaIDs: ["luna"],
                turnstileToken: "human",
              }),
            }),
            verified,
          ),
        );
        expect(joined.status).toBe(200);
        yield* f.sql`UPDATE discovery_registration SET imessage_status = 'available', imessage_checked_at = 1`;
        expect(
          (yield* f.store.list).entries.find((row) => row.handle === "+821066666666")?.reason,
        ).toBe("no_persona");
        expect(
          (yield* f.store.select({ requestId: randomUUID(), count: 1 }, "wait")).entries,
        ).toEqual([]);
      }),
    ),
  );
});

test("an ending hides a persona only for that handle while other relationships and selections continue", async () => {
  await withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* contactFixture;
        const r = yield* relationshipFixture;
        f.profiles.push({ id: "seoyul", name: "Seoyul", bio: "public", imageUrl: "" });
        const sibling = yield* r.app.directory.create({
          handle: "+821088888888",
          personaID: "seoyul",
          sessionID: "ses_sibling",
          locale: "ko",
          consentLanguage: "ko",
          consentVersion: "v1",
        });
        yield* r.ending.end(r.conversation.sessionID, "bye", "ending");
        expect(yield* r.app.directory.active(sibling)).toBe(true);
        yield* f.register(r.conversation.handle, ["seoyul"]);
        yield* f.register("+821077777777", ["seoyul"]);
        const entries = (yield* f.store.list).entries;
        expect(entries.find((row) => row.handle === r.conversation.handle)?.reason).toBe(
          "no_persona",
        );
        const selected = yield* f.store.select({ requestId: randomUUID(), count: 10 }, "others");
        expect(selected.entries.map((row) => row.handle)).toEqual(["+821077777777"]);
        yield* r.sql`INSERT INTO test_handle VALUES (${r.conversation.handle})`;
        expect(
          yield* f.store.start(
            {
              requestId: randomUUID(),
              registrationID: entries.find((row) => row.handle === r.conversation.handle)!.id,
              personaID: "seoyul",
            },
            "excluded-test",
          ),
        ).toBeNull();
      }),
    ),
  );
});

test("private listing authorizes body tokens, is uncacheable and rate limited, and never returns secrets", async () => {
  await withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* contactFixture;
        const r = yield* relationshipFixture;
        yield* r.ending.end(r.conversation.sessionID, "private farewell", "ending");
        const [ending] = yield* r.sql<{ notice: string }>`SELECT notice FROM conversation_end`;
        const token = new URL(ending!.notice.split("\n").at(-1)!).hash.slice("#reselect=".length);
        const logs: object[] = [];
        let catalogOffline = false;
        const web = yield* makeDiscoveryWeb({
          catalog: async () => {
            if (catalogOffline) throw new Error("private catalog payload");
            return f.profiles;
          },
          turnstileSecret: "secret",
          log: (event) => logs.push(event),
        });
        yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
        const requestId = randomUUID();
        const listing = (reselectionToken: string, ip: string = randomUUID()) =>
          Effect.promise(() =>
            web.handler(
              new Request("https://api.test/discovery/reselection/personas", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "CF-Connecting-IP": ip,
                  "X-Operation-ID": requestId,
                },
                body: JSON.stringify({ reselectionToken }),
              }),
              verified,
            ),
          );
        for (let attempt = 0; attempt < 6; attempt++) {
          const response = yield* listing("a".repeat(64), "limited");
          expect(response.status).toBe(400);
          expect(response.headers.get("Cache-Control")).toBe("no-store");
          expect(yield* Effect.promise(() => response.json())).toBe(
            attempt === 5 ? "try_later" : "reselection",
          );
        }
        expect((yield* listing("malformed")).status).toBe(400);
        const response = yield* listing(token);
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toEqual(f.profiles);
        catalogOffline = true;
        const before = logs.length;
        const offline = yield* listing(token);
        expect(offline.status).toBe(503);
        expect(offline.headers.get("X-Request-ID")).toBe(requestId);
        expect(yield* Effect.promise(() => offline.json())).toBe("storage");
        expect(logs.slice(before)).toHaveLength(1);
        expect(logs.at(-1)).toMatchObject({ stage: "catalog.read", causeName: "Error" });
        catalogOffline = false;
        const join = yield* Effect.promise(() =>
          web.handler(
            new Request("https://api.test/discovery/waitlist", {
              method: "POST",
              headers: { "Content-Type": "application/json", "CF-Connecting-IP": randomUUID() },
              body: JSON.stringify({
                handle: r.conversation.handle,
                locale: "ko",
                privacyNoticeVersion: discoveryNotice.version,
                likedPersonaIDs: ["luna"],
                turnstileToken: "human",
                reselectionToken: token,
              }),
            }),
            verified,
          ),
        );
        expect(join.status).toBe(200);
        expect((yield* listing(token)).status).toBe(400);
        expect(JSON.stringify(logs)).toContain(requestId);
        expect(JSON.stringify(logs)).not.toContain(token);
        expect(JSON.stringify(logs)).not.toContain("a".repeat(64));
        expect(JSON.stringify(logs)).not.toContain(r.conversation.handle);
        expect(JSON.stringify(logs)).not.toContain("private farewell");
        yield* r.sql`DROP TABLE persona_exclusion`;
        yield* r.sql`UPDATE conversation_end SET consumed_at = NULL`;
        const unavailable = yield* listing(token);
        expect(unavailable.status).toBe(503);
        expect(yield* Effect.promise(() => unavailable.json())).toBe("storage");
        expect(logs.at(-1)).toMatchObject({
          stage: "catalog.authorize",
          code: "storage",
          level: "error",
          causeName: "UnknownError",
        });
      }),
    ),
  );
});
