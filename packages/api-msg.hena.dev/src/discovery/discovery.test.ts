import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersonaStore } from "@ren-ai/personas";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Context, Effect } from "effect";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { discoveryNotice } from "@ren-ai/onboarding";
import { migrate } from "../database.ts";
import { makeDiscoveryWeb } from "./discovery.ts";

const http = HttpClient.make((request) =>
  Effect.sync(() =>
    HttpClientResponse.fromWeb(
      request,
      Response.json({
        success:
          request.body instanceof HttpBody.Uint8Array &&
          new TextDecoder().decode(request.body.body).includes("response=human"),
      }),
    ),
  ),
);

test("a visitor registers liked personas durably and repeats cannot change an existing request", async () => {
  const root = await mkdtemp(join(tmpdir(), "discovery-intake-"));
  try {
    const store = await createPersonaStore(join(root, "personas"));
    await store.create({
      id: "sora",
      name: "소라",
      bio: "밤에는 음악을 만들어요.",
      imageUrl: "https://example.org/sora.jpg",
      published: true,
      language: "ko",
      timeZone: "Asia/Seoul",
      openingLine: "인사해",
      memory: "기억해",
      prompt: "Private OpenCode prompt",
    });
    await mkdir(join(root, "state"));
    const database = join(root, "state", "server.sqlite");
    const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename: database }))));
    await run(
      Effect.gen(function* () {
        yield* migrate;
        const web = yield* makeDiscoveryWeb({
          catalog: store.publicList,
          turnstileSecret: "test-secret",
        });
        yield* Effect.tryPromise(async () => {
          try {
            const profiles = await web.handler(
              new Request("http://localhost/discovery/personas"),
              Context.make(HttpClient.HttpClient, http),
            );
            expect(await profiles.json()).toEqual([
              {
                id: "sora",
                name: "소라",
                bio: "밤에는 음악을 만들어요.",
                imageUrl: "https://example.org/sora.jpg",
              },
            ]);
            const submit = (likedPersonaIDs = ["sora"]) =>
              web.handler(
                new Request("http://localhost/discovery/waitlist", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "CF-Connecting-IP": "a" },
                  body: JSON.stringify({
                    handle: "+821012345678",
                    locale: "ko",
                    privacyNoticeVersion: discoveryNotice.version,
                    turnstileToken: "human",
                    likedPersonaIDs,
                  }),
                }),
                Context.make(HttpClient.HttpClient, http),
              );
            const response = await submit();
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ status: "waiting" });
            expect((await submit()).status).toBe(200);
          } finally {
            await web.dispose();
          }
        });
      }),
    );
    await run(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        expect(
          yield* sql<{
            handle: string;
            consent_version: string;
          }>`SELECT handle, consent_version FROM discovery_registration`,
        ).toEqual([{ handle: "+821012345678", consent_version: discoveryNotice.version }]);
        expect(yield* sql<{ persona_id: string }>`SELECT persona_id FROM discovery_like`).toEqual([
          { persona_id: "sora" },
        ]);
        expect(yield* sql`SELECT id FROM conversation`).toEqual([]);
        expect(yield* sql`SELECT id FROM send`).toEqual([]);
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
