import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { cloudflareFixture } from "./cloudflare-fixture.ts";
import { seedCharacter, seedManifest, uploadSeeds } from "./seeding.ts";
import { acceptedReview } from "./character.ts";
import { portraitReply, request } from "./fixtures.ts";

type Reply = { body: string; status: number };

const unavailable: Reply = {
  body: JSON.stringify({ error: { status: "UNAVAILABLE" } }),
  status: 503,
};

let worker: Promise<string> | undefined;

const workerSource = () =>
  (worker ??= build({
    entryPoints: [fileURLToPath(new URL("../worker/test-seeding.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker"],
    mainFields: ["module", "main"],
    target: "es2023",
    external: ["node:*", "cloudflare:workers"],
  }).then(({ outputFiles }) => outputFiles[0]!.text));

const scriptedReply = async (response: Response): Promise<Reply> => ({
  body: await response.text(),
  status: response.status,
});

const providerScript = async (failedImage: number | undefined) => {
  const replies: Reply[] = [];
  for (const seed of seedManifest().seeds) {
    replies.push(await scriptedReply(seedCharacter(seed)), await scriptedReply(acceptedReview()));
    for (let image = 0; image < 4; image++)
      replies.push(await scriptedReply(await portraitReply()));
  }
  if (failedImage !== undefined) replies[failedImage] = unavailable;
  return replies;
};

export async function durableSeedingFixture(options: { failedImage?: number } = {}) {
  const { runtime, store, db } = await cloudflareFixture(await workerSource());
  const call = async (input: Request) => {
    const response = await runtime.dispatchFetch(input.url, {
      method: input.method,
      headers: Object.fromEntries(input.headers),
      ...(input.method === "POST" && { body: await input.text() }),
      redirect: "manual",
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  };
  await call(
    new Request("http://localhost:3729/test/script", {
      method: "POST",
      body: JSON.stringify(await providerScript(options.failedImage)),
    }),
  );
  const location = (await call(uploadSeeds())).headers.get("location")!;
  expect((await call(request(location, { intent: "confirm", budget: "12" }))).status).toBe(303);
  const evict = () =>
    runtime.unsafeEvictDurableObject("test", "PersonaAdmin", { name: "seeding-test" });
  const step = async () => {
    expect((await call(request("/test/step"))).status).toBe(200);
  };
  const expectCalls = async (count: number) => {
    expect(await (await call(request("/test/calls"))).json()).toHaveLength(count);
  };
  for (let i = 0; i < 48; i++) {
    await step();
    await evict();
  }
  return { store, db, call, location, evict, step, expectCalls };
}
