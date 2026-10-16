import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { createPersonaStore } from "@ren-ai/personas";
import { discoveryNotice } from "@ren-ai/onboarding";
import { expect, test } from "vitest";
import { startDiscovery } from "../../test/discovery-server.test-helper.ts";
import { makeOperator } from "../operator/operator.ts";
import { conversations } from "../conversations/conversations.ts";
import { withPublicProfile } from "@ren-ai/personas/profile";
import { startTestCatalog } from "../../test/catalog.test-helper.ts";
import { makeDiscoveryWeb } from "./discovery.ts";

test("the discovery HTTP adapter accepts real HTTP and operator removal deletes waiting preferences", async () => {
  const root = await mkdtemp(join(tmpdir(), "discovery-server-"));
  try {
    const store = await createPersonaStore(join(root, "profiles"));
    await store.create({
      id: "hayeon",
      name: "하연",
      bio: "함께 요리해요.",
      imageUrl: "https://example.net/hayeon.png",
      published: true,
      language: "ko",
      timeZone: "Asia/Seoul",
      openingLine: "Hi",
      memory: "Keep memories",
      prompt: withPublicProfile("Private instructions", "함께 요리해요."),
    });
    const human = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: true }))),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const remoteCatalog = yield* Effect.acquireRelease(
            Effect.promise(() => startTestCatalog(join(root, "profiles"))),
            (catalog) => Effect.promise(catalog.close),
          );
          const server = yield* startDiscovery({
            port: 0,
            catalogUrl: remoteCatalog.url,
            turnstileSecret: "secret",
          });
          const address = server.address();
          if (!address || typeof address === "string")
            throw new Error("Missing discovery listener");
          const sql = yield* SqlClient.SqlClient;
          yield* Effect.tryPromise(async () => {
            const base = `http://127.0.0.1:${address.port}`;
            const response = await fetch(`${base}/discovery/personas`);
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual([
              {
                id: "hayeon",
                name: "하연",
                bio: "함께 요리해요.",
                imageUrl: "https://example.net/hayeon.png",
                profile: { introduction: "함께 요리해요.", sections: [] },
              },
            ]);
            const imageUrl = await store.saveImage({
              bytes: Buffer.from("89504e470d0a1a0a", "hex"),
              mimeType: "image/png",
            });
            expect((await fetch(`${base}${imageUrl}`)).status).toBe(404);
            const saved = await store.get("hayeon");
            const photoUrl = await store.saveImage({
              bytes: Buffer.from("89504e470d0a1a0a", "hex"),
              mimeType: "image/png",
            });
            const portraits = { anime: imageUrl, photo: photoUrl };
            await store.update({
              ...saved,
              imageUrl: photoUrl,
              portraits,
              description: withPublicProfile("Private character source", "함께 요리해요."),
            });
            const portrait = await fetch(`${base}${imageUrl}`);
            expect(portrait.status).toBe(200);
            expect(portrait.headers.get("content-type")).toBe("image/png");
            expect((await fetch(`${base}${photoUrl}`)).status).toBe(200);
            expect(Buffer.from(await portrait.arrayBuffer()).toString("hex")).toBe(
              "89504e470d0a1a0a",
            );
            const readonly = await fetch(`${base}${imageUrl}`, { method: "POST" });
            expect(readonly.status).toBe(405);
            expect(readonly.headers.get("allow")).toBe("GET");
            const publicProfileEntry = {
              id: "hayeon",
              name: "하연",
              bio: "함께 요리해요.",
              imageUrl: `${remoteCatalog.url}${photoUrl}`,
              portraits: {
                anime: `${remoteCatalog.url}${imageUrl}`,
                photo: `${remoteCatalog.url}${photoUrl}`,
              },
              profile: { introduction: "함께 요리해요.", sections: [] },
            };
            const catalog = await fetch(`${base}/discovery/personas`);
            expect(await catalog.json()).toEqual([publicProfileEntry]);
            const extraUrl = await store.saveImage({
              bytes: Buffer.from("89504e470d0a1a0a", "hex"),
              mimeType: "image/png",
            });
            const portraitGallery = [portraits, { anime: extraUrl, photo: extraUrl }];
            await store.update({ ...(await store.get("hayeon")), portraitGallery });
            expect(await (await fetch(`${base}/discovery/personas`)).json()).toEqual([
              {
                ...publicProfileEntry,
                secondaryPortraits: [
                  { style: "anime", imageUrl: `${remoteCatalog.url}${extraUrl}` },
                  { style: "photo", imageUrl: `${remoteCatalog.url}${extraUrl}` },
                ],
              },
            ]);
            expect((await fetch(`${base}${extraUrl}`)).status).toBe(200);
            const publicProfile = "함께 요리해요.\n\n### 같이 하고 싶은 일\n- 베이킹\n- 산책";
            await store.update({
              ...(await store.get("hayeon")),
              descriptionVersion: 2,
              description: withPublicProfile("Private character source", publicProfile),
            });
            const enriched = await (await fetch(`${base}/discovery/personas`)).text();
            expect(JSON.parse(enriched)).toMatchObject([
              {
                profile: {
                  introduction: "함께 요리해요.",
                  sections: [
                    { type: "text", title: "같이 하고 싶은 일", body: "• 베이킹\n• 산책" },
                  ],
                },
              },
            ]);
            for (const field of [
              "descriptionVersion",
              "Private character source",
              "memory",
              "prompt",
              "publicProfile",
              "###",
            ])
              expect(enriched).not.toContain(field);
            const filename = imageUrl.split("/").at(-1)!;
            await rm(join(root, "profiles", "images", filename));
            await mkdir(join(root, "profiles", "images", filename));
            const unavailable = await fetch(`${base}${imageUrl}`);
            expect(unavailable.status).toBe(503);
            expect(await unavailable.text()).toBe("");
            const joined = await fetch(`${base}/discovery/waitlist`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                handle: "waiting@example.com",
                locale: "ko",
                privacyNoticeVersion: discoveryNotice.version,
                turnstileToken: "human",
                likedPersonaIDs: ["hayeon"],
              }),
            });
            expect(joined.status).toBe(200);
            expect(await joined.json()).toEqual({ status: "waiting" });
          });
          expect(yield* sql`SELECT persona_id FROM discovery_like`).toHaveLength(1);
          const directory = yield* conversations;
          const operator = yield* makeOperator(directory, () => Effect.void);
          expect(yield* operator.remove("waiting@example.com")).toBe("removed");
          expect(yield* sql`SELECT id FROM discovery_registration`).toEqual([]);
          expect(yield* sql`SELECT persona_id FROM discovery_like`).toEqual([]);
          expect(yield* sql`SELECT id FROM send`).toEqual([]);
          yield* Effect.promise(async () => {
            await remoteCatalog.close();
            const unavailable = await fetch(
              `http://127.0.0.1:${address.port}/discovery/images/00000000-0000-0000-0000-000000000000.png`,
            );
            expect(unavailable.status).toBe(503);
            expect(unavailable.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
          });
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            SqliteClient.layer({ filename: ":memory:" }),
            Layer.succeed(HttpClient.HttpClient, human),
          ),
        ),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the image boundary turns opaque and numeric-code failures into correlated unavailable responses", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let failure: string | Error = "opaque private failure";
        const web = yield* makeDiscoveryWeb({
          catalog: async () => [],
          turnstileSecret: "",
          image: async () => {
            throw failure;
          },
        });
        yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
        const client = yield* HttpClient.HttpClient;
        for (const cause of [
          "opaque private failure",
          new Error("private read failure"),
          Object.assign(new Error("private read failure"), { code: 14 }),
          Object.assign(new Error("private read failure"), { code: {} }),
        ]) {
          failure = cause;
          const response = yield* Effect.promise(() =>
            web.handler(
              new Request("https://api.test/discovery/images/photo.png"),
              Context.make(HttpClient.HttpClient, client),
            ),
          );
          expect(response.status).toBe(503);
          expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
          expect(yield* Effect.promise(() => response.text())).toBe("");
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            SqliteClient.layer({ filename: ":memory:" }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.succeed(HttpClientResponse.fromWeb(request, new Response())),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});
