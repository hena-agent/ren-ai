// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { withPublicProfile } from "@ren-ai/personas/profile";
import { catalogFixture } from "../test/catalog-fixture.ts";

test("the packaged Discovery Worker reads real D1 and delegates SPA/assets without contacting the messaging API", async () => {
  execFileSync("bun", [fileURLToPath(new URL("../scripts/build-worker.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
  const source = await readFile(new URL("../dist/worker/entry.js", import.meta.url), "utf8");
  const { runtime, persona, photo } = await catalogFixture(source);
  await persona("public", withPublicProfile("private source", "안녕하세요."));
  await persona("hidden", withPublicProfile("secret", "비공개"), false);
  const key = "01234567-89ab-cdef-0123-456789abcdef.png";
  await photo("public", key, "photo", 0);
  const response = await runtime.dispatchFetch("https://discovery.example/api/personas");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([
    {
      id: "public",
      name: "public",
      bio: "안녕하세요.",
      publicProfile: "안녕하세요.",
      imageUrl: `https://admin.example/discovery/images/${key}`,
      portraits: { photo: `https://admin.example/discovery/images/${key}` },
      secondaryPortraits: [],
    },
  ]);
  expect(await (await runtime.dispatchFetch("https://discovery.example/")).text()).toBe(
    "discovery assets",
  );
  expect(
    (await runtime.dispatchFetch("https://discovery.example/api/personas", { method: "POST" }))
      .status,
  ).toBe(405);
});
