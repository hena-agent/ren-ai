import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { createPersonaStore } from "@ren-ai/personas";
import { discoveryNotice } from "@ren-ai/onboarding";
import { expect, test } from "vitest";
import { startDiscovery } from "../../test/discovery-server.test-helper.ts";
import { makeOperator } from "../operator/operator.ts";
import { conversations } from "../conversations/conversations.ts";
import { withPublicProfile } from "@ren-ai/personas/profile";
import { startTestCatalog } from "../../test/catalog.test-helper.ts";
import { invalidatePublicCatalog } from "../personas/public-catalog.ts";

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
          const invalidate = invalidatePublicCatalog.pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          yield* Effect.tryPromise(async () => {
            const base = `http://127.0.0.1:${address.port}`;
            const response = await fetch(`${base}/discovery/personas?locale=ko`);
            expect(response.status).toBe(200);
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(await response.json()).toEqual({
              nextCursor: null,
              people: [
                {
                  id: "hayeon",
                  name: "하연",
                  bio: "함께 요리해요.",
                  imageUrl: "https://example.net/hayeon.png",
                  profile: { introduction: "함께 요리해요.", sections: [] },
                },
              ],
            });
            const imageUrl = (
              await store.saveImage({
                bytes: Buffer.from("89504e470d0a1a0a", "hex"),
                mimeType: "image/png",
              })
            ).replace("/images/", "https://persona-images.renai.im/");
            const saved = await store.get("hayeon");
            const photoUrl = (
              await store.saveImage({
                bytes: Buffer.from("89504e470d0a1a0a", "hex"),
                mimeType: "image/png",
              })
            ).replace("/images/", "https://persona-images.renai.im/");
            const portraits = { anime: imageUrl, photo: photoUrl };
            await store.update({
              ...saved,
              imageUrl: photoUrl,
              portraits,
              description: withPublicProfile("Private character source", "함께 요리해요."),
            });
            for (const method of ["GET", "POST"]) {
              expect(
                (await fetch(`${base}/discovery/images/${imageUrl.split("/").at(-1)}`, { method }))
                  .status,
              ).toBe(404);
            }
            const publicProfileEntry = {
              id: "hayeon",
              name: "하연",
              bio: "함께 요리해요.",
              imageUrl: photoUrl,
              portraits: {
                anime: imageUrl,
                photo: photoUrl,
              },
              profile: { introduction: "함께 요리해요.", sections: [] },
            };
            expect(
              await (await fetch(`${base}/discovery/personas?locale=ko`)).json(),
            ).toMatchObject({ people: [{ imageUrl: "https://example.net/hayeon.png" }] });
            await Effect.runPromise(invalidate);
            const catalog = await fetch(`${base}/discovery/personas?locale=ko`);
            expect(await catalog.json()).toEqual({
              people: [publicProfileEntry],
              nextCursor: null,
            });
            const extraUrl = (
              await store.saveImage({
                bytes: Buffer.from("89504e470d0a1a0a", "hex"),
                mimeType: "image/png",
              })
            ).replace("/images/", "https://persona-images.renai.im/");
            const portraitGallery = [portraits, { anime: extraUrl, photo: extraUrl }];
            await store.update({ ...(await store.get("hayeon")), portraitGallery });
            await Effect.runPromise(invalidate);
            expect(await (await fetch(`${base}/discovery/personas?locale=ko`)).json()).toEqual({
              nextCursor: null,
              people: [
                {
                  ...publicProfileEntry,
                  secondaryPortraits: [
                    { style: "anime", imageUrl: extraUrl },
                    { style: "photo", imageUrl: extraUrl },
                  ],
                },
              ],
            });
            const publicProfile = "함께 요리해요.\n\n### 같이 하고 싶은 일\n- 베이킹\n- 산책";
            await store.update({
              ...(await store.get("hayeon")),
              descriptionVersion: 2,
              description: withPublicProfile("Private character source", publicProfile),
            });
            await Effect.runPromise(invalidate);
            const enriched = await (await fetch(`${base}/discovery/personas?locale=ko`)).text();
            expect(JSON.parse(enriched)).toMatchObject({
              people: [
                {
                  profile: {
                    introduction: "함께 요리해요.",
                    sections: [
                      { type: "text", title: "같이 하고 싶은 일", body: "• 베이킹\n• 산책" },
                    ],
                  },
                },
              ],
            });
            for (const field of [
              "descriptionVersion",
              "Private character source",
              "memory",
              "prompt",
              "publicProfile",
              "###",
            ])
              expect(enriched).not.toContain(field);
            const joined = await fetch(`${base}/discovery/waitlist`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                handle: "+821012345678",
                locale: "ko",
                privacyNoticeVersion: discoveryNotice.version,
                turnstileToken: "human",
                name: "Visitor",
                likedPersonaIDs: ["hayeon"],
              }),
            });
            expect(joined.status).toBe(200);
            expect(await joined.json()).toEqual({ status: "waiting" });
          });
          expect(yield* sql`SELECT persona_id FROM discovery_like`).toHaveLength(1);
          expect(yield* sql`SELECT state FROM discovery_notification`).toEqual([
            { state: "queued" },
          ]);
          const directory = yield* conversations;
          const operator = yield* makeOperator(directory, () => Effect.void);
          expect(yield* operator.remove("+821012345678")).toBe("removed");
          expect(yield* sql`SELECT id FROM discovery_registration`).toEqual([]);
          expect(yield* sql`SELECT persona_id FROM discovery_like`).toEqual([]);
          expect(yield* sql`SELECT state FROM discovery_notification`).toEqual([]);
          expect(yield* sql`SELECT id FROM send`).toEqual([]);
          yield* Effect.promise(async () => {
            await remoteCatalog.close();
            const removed = await fetch(
              `http://127.0.0.1:${address.port}/discovery/images/00000000-0000-0000-0000-000000000000.png`,
            );
            expect(removed.status).toBe(404);
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
