import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { createPersonaStore } from "@ren-ai/personas";
import { discoveryNotice } from "@ren-ai/onboarding";
import { expect, test } from "vitest";
import { startDiscovery } from "./server.ts";
import { makeOperator } from "../operator/operator.ts";
import { conversations } from "../conversations/conversations.ts";

test("the standalone discovery listener accepts real HTTP and operator removal deletes waiting preferences", async () => {
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
      prompt: "Private instructions",
    });
    const human = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: true }))),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startDiscovery({
            port: 0,
            personaDirectory: join(root, "profiles"),
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
              description: "Private character source",
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
            const catalog = await fetch(`${base}/discovery/personas`);
            expect(await catalog.json()).toEqual([
              { id: "hayeon", name: "하연", bio: "함께 요리해요.", imageUrl: photoUrl, portraits },
            ]);
            const extraUrl = await store.saveImage({
              bytes: Buffer.from("89504e470d0a1a0a", "hex"),
              mimeType: "image/png",
            });
            const portraitGallery = [portraits, { anime: extraUrl, photo: extraUrl }];
            await store.update({ ...(await store.get("hayeon")), portraitGallery });
            expect(await (await fetch(`${base}/discovery/personas`)).json()).toEqual([
              {
                id: "hayeon",
                name: "하연",
                bio: "함께 요리해요.",
                imageUrl: photoUrl,
                portraits,
                secondaryPortraits: [
                  { style: "anime", imageUrl: extraUrl },
                  { style: "photo", imageUrl: extraUrl },
                ],
              },
            ]);
            expect((await fetch(`${base}${extraUrl}`)).status).toBe(200);
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
