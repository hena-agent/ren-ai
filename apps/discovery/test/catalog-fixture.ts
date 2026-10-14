import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach } from "vitest";

const runtimes: Miniflare[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

export async function catalogFixture(
  workerSource = "export default {fetch(){return new Response('assets')}}",
) {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "discovery-test",
          compatibilityDate: "2026-10-13",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: workerSource } },
          },
          env: {
            DB: { type: "d1", id: "catalog" },
            PERSONA_CATALOG_URL: { type: "text", value: "https://admin.example" },
            ASSETS: { type: "worker", worker: "assets" },
          },
        },
      },
      {
        config: {
          name: "assets",
          compatibilityDate: "2026-10-13",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: "export default {fetch(){return new Response('discovery assets')}}",
              },
            },
          },
        },
      },
    ],
  });
  runtimes.push(runtime);
  const db = await runtime.getD1Database("DB");
  const ddl = await readFile(
    new URL("../../admin/drizzle/0000_chilly_warpath.sql", import.meta.url),
    "utf8",
  );
  await db.batch(
    ddl.split("--> statement-breakpoint").map((statement) => db.prepare(statement.trim())),
  );
  const persona = async (id: string, markdown: string, published = true) =>
    db
      .prepare(`
    INSERT INTO personas (id, name, markdown, timeZone, language, openingLine, memoryInstruction, published, state, memory, revision, commitId, createdAt, updatedAt)
    VALUES (?, ?, ?, 'UTC', 'ko', 'private opening', 'private instruction', ?, 'private state', 'private memory', 1, 'commit', 1, 1)
  `)
      .bind(id, id, markdown, Number(published))
      .run();
  const photo = async (id: string, key: string, style: string, position: number) =>
    db
      .prepare(`
    INSERT INTO persona_images (personaId, objectKey, style, position, mimeType, size) VALUES (?, ?, ?, ?, 'image/png', 1)
  `)
      .bind(id, key, style, position)
      .run();
  return { runtime, db, persona, photo };
}
