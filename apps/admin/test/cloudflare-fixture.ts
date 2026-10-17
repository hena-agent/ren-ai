import { readFile } from "node:fs/promises";
import journal from "../drizzle/meta/_journal.json" with { type: "json" };
import { Miniflare } from "miniflare";
import { afterEach } from "vitest";
import { decodePersona } from "@ren-ai/personas";
import { databaseStore } from "../src/database-store.ts";
import { femaleCharacter, legacy } from "./fixtures.ts";
import type { AdminEnv } from "../src/cloudflare-admin.ts";

export const adminBindings = (db: AdminEnv["DB"], bucket: AdminEnv["IMAGES"]): AdminEnv => ({
  DB: db,
  IMAGES: bucket,
  ASSETS: { fetch: async () => new Response("asset") },
  ADMIN_PASSWORD: "test-password",
  TOKEN_CATALOG: "catalog",
});

const runtimes: Miniflare[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

export const databasePersona = decodePersona({
  ...legacy,
  ...femaleCharacter,
  id: "harin",
  prompt: femaleCharacter.description,
  imageUrl: "",
});

export async function cloudflareFixture(
  workerSource?: string,
  assetsSource = "export default {fetch(){return new Response('asset')}}",
  beforeVersions?: (db: Awaited<ReturnType<Miniflare["getD1Database"]>>) => Promise<void>,
) {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "test",
          compatibilityDate: "2026-10-11",
          compatibilityFlags: ["nodejs_compat"],
          ...(workerSource && {
            exports: {
              PersonaAdmin: { type: "durable-object" as const, storage: "sqlite" as const },
            },
          }),
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: workerSource ?? "export default {fetch(){return new Response('ok')}}",
              },
            },
          },
          env: {
            DB: { type: "d1", id: "test" },
            IMAGES: { type: "r2", name: "test" },
            ...(workerSource && {
              ADMIN: {
                type: "durable-object" as const,
                worker: "test",
                exportName: "PersonaAdmin",
              },
              ASSETS: { type: "worker" as const, worker: "assets" },
              ADMIN_PASSWORD: { type: "text" as const, value: "test-password" },
              ADMIN_JURISDICTION: { type: "text" as const, value: "local" },
              TOKEN_CATALOG: { type: "text" as const, value: "catalog-test" },
              GEMINI_API_KEY: { type: "text" as const, value: "" },
            }),
          },
        },
      },
      {
        config: {
          name: "assets",
          compatibilityDate: "2026-10-11",
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: assetsSource } },
          },
        },
      },
    ],
  });
  runtimes.push(runtime);
  const db = await runtime.getD1Database("DB");
  const bucket = await runtime.getR2Bucket("IMAGES");
  for (const migration of journal.entries) {
    const file = `${migration.tag}.sql`;
    if (file === "0001_persona_versions.sql") await beforeVersions?.(db);
    const ddl = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    await db.batch(
      ddl.split("--> statement-breakpoint").map((statement) => db.prepare(statement.trim())),
    );
  }
  return { runtime, db, bucket, store: databaseStore(db, bucket) };
}
