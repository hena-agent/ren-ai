import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import journal from "../drizzle/meta/_journal.json" with { type: "json" };
import { Miniflare } from "miniflare";
import { Schema } from "effect";
import { afterEach } from "vitest";
import { decodePersona } from "@ren-ai/personas";
import { databaseStore } from "../src/database-store.ts";
import { femaleCharacter, legacy } from "./fixtures.ts";
import type { AdminEnv } from "../src/cloudflare-admin.ts";

export const adminBindings = (db: AdminEnv["DB"], bucket: AdminEnv["IMAGES"]): AdminEnv => ({
  DB: db,
  IMAGES: bucket,
  ADMIN_PASSWORD: "test-password",
  TOKEN_CATALOG: "catalog",
});

/** The deployed static-asset routing, so Worker tests observe what the edge serves first. */
async function deployedAssets() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const config = await readFile(`${root}/wrangler.jsonc`, "utf8");
  const routes = /"run_worker_first":\s*(\[[^\]]*\])/.exec(config)![1]!;
  return {
    directory: `${root}/public`,
    hasUserWorker: true,
    runWorkerFirst: [...Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(routes))],
  };
}

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

/** A built Worker: its entry source and the WebAssembly modules it imports by filename. */
export interface WorkerBundle {
  source: string;
  wasm: Record<string, Uint8Array<ArrayBuffer>>;
}

export async function cloudflareFixture(
  worker?: WorkerBundle,
  beforeVersions?: (db: Awaited<ReturnType<Miniflare["getD1Database"]>>) => Promise<void>,
  text: Record<string, string> = {},
) {
  const workerSource = worker?.source;
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
            assets: await deployedAssets(),
          }),
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: workerSource ?? "export default {fetch(){return new Response('ok')}}",
              },
              ...Object.fromEntries(
                Object.entries(worker?.wasm ?? {}).map(([name, contents]) => [
                  name,
                  { type: "wasm" as const, contents },
                ]),
              ),
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
              ...Object.fromEntries(
                Object.entries({
                  ADMIN_PASSWORD: "test-password",
                  ADMIN_JURISDICTION: "local",
                  TOKEN_CATALOG: "catalog-test",
                  GEMINI_API_KEY: "",
                  ...text,
                }).map(([name, value]) => [name, { type: "text" as const, value }]),
              ),
            }),
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
