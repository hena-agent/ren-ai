import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Schema, type Scope } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { fromPartial } from "@total-typescript/shoehorn";
import { Session } from "@opencode/schema/session";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { ConversationList, discoveryNotice } from "@ren-ai/onboarding";
import { expect, test } from "vitest";
import { migrate } from "../database.ts";
import { conversationStatus } from "../conversations/status.ts";
import { conversationRecords } from "../conversations/http.ts";
import { conversations } from "../conversations/conversations.ts";
import { usageQueries } from "../usage/query.ts";
import type { PersonaRuntime } from "../opencode/runtime.ts";
import { contactFixture, withContactDatabase } from "./contact.test-helper.ts";
import { makeDiscoveryWeb } from "./discovery.ts";
import { checkAvailability } from "./availability.ts";
import { contacts } from "./contacts.ts";
import { firstContacts } from "./first-contact.ts";

const catalog = async () => [{ id: "luna", name: "Luna", bio: "public", imageUrl: "" }];

const startContacts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE discovery_contact SET scheduled_at = 0`;
  const host = fromPartial<PersonaRuntime>({
    personas: new Map([
      ["luna", { id: "luna", published: true, timeZone: "Asia/Seoul", openingLine: "Hello" }],
    ]),
    createSession: () =>
      Effect.succeed(fromPartial<Session.Info>({ id: Session.ID.make("ses_style") })),
    sessions: { prompt: () => Effect.succeed(fromPartial<SessionInbox.User>({})) },
  });
  const directory = yield* conversations;
  const worker = yield* firstContacts(
    host,
    { textStatus: () => Effect.succeed("unknown") },
    directory,
    "test/probe",
    () => {},
  );
  yield* worker.tick;
});

const readConversations = Effect.gen(function* () {
  const status = yield* conversationStatus(async () => []);
  const records = conversationRecords(status, Effect.runPromise, yield* usageQueries);
  const response = yield* Effect.promise(() =>
    records(new Request("https://api.test/management/conversations")),
  );
  return {
    status: response.status,
    ...Schema.decodeUnknownSync(ConversationList)(yield* Effect.promise(() => response.json())),
  };
});

test.each([
  ["photo", "photo"],
  ["anime", "anime"],
  [undefined, "anime"],
])(
  "registration style %s survives reconstruction and duplicate submissions as %s",
  async (chosenStyle, expectedStyle) => {
    const root = await mkdtemp(join(tmpdir(), "conversation-style-"));
    const run = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>) =>
      Effect.runPromise(
        Effect.scoped(program).pipe(
          Effect.provide(SqliteClient.layer({ filename: join(root, "server.sqlite") })),
        ),
      );
    try {
      await run(
        Effect.gen(function* () {
          yield* contactFixture;
          const web = yield* makeDiscoveryWeb({ catalog, turnstileSecret: "secret" });
          yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
          for (const imageStyle of [
            chosenStyle,
            expectedStyle === "photo" ? "anime" : "photo",
            "invalid",
            null,
          ]) {
            const response = yield* Effect.promise(() =>
              web.handler(
                new Request("https://api.test/discovery/waitlist", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    handle: "+821012345678",
                    locale: "ko",
                    privacyNoticeVersion: discoveryNotice.version,
                    likedPersonaIDs: ["luna"],
                    turnstileToken: "human",
                    name: "Visitor",
                    imageStyle,
                  }),
                }),
                Context.make(
                  HttpClient.HttpClient,
                  HttpClient.make((request) =>
                    Effect.succeed(
                      HttpClientResponse.fromWeb(request, Response.json({ success: true })),
                    ),
                  ),
                ),
              ),
            );
            expect(response.status).toBe(
              imageStyle === "invalid" || imageStyle === null ? 400 : 200,
            );
            if (response.status === 200)
              expect(yield* Effect.promise(() => response.json())).toEqual({ status: "waiting" });
          }
        }),
      );
      await run(
        Effect.gen(function* () {
          yield* migrate;
          const store = yield* contacts(catalog);
          yield* checkAvailability(
            (yield* store.list).entries[0]!.id,
            { availability: () => Effect.succeed({ available: true, requestId: randomUUID() }) },
            () => {},
          );
          yield* store.select({ requestId: randomUUID(), count: 1 }, "style-selection");
          yield* startContacts;
        }),
      );
      await run(
        Effect.gen(function* () {
          yield* migrate;
          const page = yield* readConversations;
          expect(page.status).toBe(200);
          expect(page.entries).toHaveLength(1);
          expect(page.entries[0]).toHaveProperty("imageStyle", expectedStyle);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM discovery_registration`;
          expect((yield* readConversations).entries[0]).toHaveProperty("imageStyle", expectedStyle);
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("forward migration defaults existing Conversations and waiting registrations to anime", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      // Recreate the persisted schema immediately before the image-style migration.
      yield* f.sql`ALTER TABLE discovery_registration DROP COLUMN image_style`;
      yield* f.sql`ALTER TABLE conversation DROP COLUMN image_style`;
      yield* f.sql`DELETE FROM effect_sql_migrations WHERE migration_id = 53`;
      yield* f.register("+821012345678");
      const directory = yield* conversations;
      yield* directory.create({
        handle: "+821087654321",
        locale: "ko",
        consentVersion: "v1",
        consentLanguage: "ko",
        personaID: "harin",
        sessionID: "ses_existing",
      });
      yield* migrate;
      yield* f.store.select({ requestId: randomUUID(), count: 1 }, "legacy-style");
      yield* startContacts;
      const page = yield* readConversations;
      expect(page.status).toBe(200);
      expect(page.entries).toHaveLength(2);
      expect(page.entries.map((entry) => entry.imageStyle)).toEqual(["anime", "anime"]);
    }),
  );
});
