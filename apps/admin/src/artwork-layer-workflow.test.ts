import { expect, test } from "vitest";
import { Schema } from "effect";
import { durableFixture } from "../test/durable-admin.ts";
import { databasePersona } from "../test/cloudflare-fixture.ts";
import {
  character,
  generator,
  initialDocuments,
  portraitImage,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import { layerFetch, layerService } from "../test/artwork-layers.ts";
import { fetchUrl } from "../test/fetch-url.ts";
import { ArtworkLayerOptions } from "./artwork-layer-model.ts";
import { loggedJob } from "./logging.ts";

const form = (draft: string, quote: string) => ({
  ...character,
  draft,
  intent: "rig-layers",
  layerizeQuote: quote,
  imageCount: "1",
  portraitInstructions: "private layer instruction",
});

test("the real D1 queue confirms once, checkpoints PNGs and recovers private layers after actor replacement", async () => {
  const { service, fetcher } = layerService();
  let downloadFailed = false;
  fetcher.mockImplementation(async (input, init) => {
    if (fetchUrl(input).endsWith("arm.png") && !downloadFailed) {
      downloadFailed = true;
      return new Response(null, { status: 503 });
    }
    return layerFetch(input, init);
  });
  const f = await durableFixture({ ...generator, layerize: service });
  await f.store.save(databasePersona, initialDocuments, { persona: "" });
  const source = {
    model: "fal:source",
    imageUrl: await f.store.saveImage(portraitImage),
    operationId: "art-source",
  };
  await f.store.saveRigArtwork(databasePersona.id, source);
  let admin = f.open();
  const path = `/personas/${databasePersona.id}`;
  const draft = tokenOf(await (await admin(request(path))).text());
  const price = await admin(
    request(`/artwork-layer-options?persona=${databasePersona.id}&source=${source.operationId}`),
  );
  const options = Schema.decodeUnknownSync(ArtworkLayerOptions)(await price.json());
  expect(
    fetcher.mock.calls.filter(
      ([input, init]) =>
        fetchUrl(input).startsWith("https://queue.fal.run/") && init?.method === "POST",
    ),
  ).toHaveLength(0);
  expect(
    (await admin(request(path, { ...form(draft, options.quote), imageCount: "2" }))).status,
  ).toBe(400);
  expect(
    (await admin(request(path, { ...form(draft, options.quote), layerizeQuote: "tampered" })))
      .status,
  ).toBe(400);
  const submission = request(path, form(draft, options.quote));
  const queued = await admin(submission.clone());
  expect(queued.status).toBe(303);
  expect((await admin(submission.clone())).headers.get("location")).toBe(
    queued.headers.get("location"),
  );
  expect(
    (await admin(request(path, { ...character, draft, intent: "rig-artwork" }))).status,
  ).not.toBe(303);
  let job = admin.nextJob()!;
  const failedRequestId = job.requestId;
  await loggedJob(job.requestId, { personaId: databasePersona.id }, admin.runNext, (entry) =>
    f.logs.push(entry),
  );
  expect(
    f.logs.find(
      (entry) => entry.event === "operation.failed" && entry.stage === "rig.layers.download",
    ),
  ).toMatchObject({
    requestId: failedRequestId,
    level: "error",
    code: "image_http_error",
    status: 503,
  });
  expect(f.state.saved!.queue.jobs[0]!.batch.layerize!.saved).toHaveLength(1);
  expect((await f.store.rigArtwork(databasePersona.id))!.layers).toBeUndefined();
  admin = f.open();
  const jobUrl = queued.headers.get("location")!;
  const failedDraft = tokenOf(await (await admin(request(jobUrl))).text());
  const retry = await admin(
    request(`${jobUrl}/retry?image=0`, {
      ...character,
      draft: failedDraft,
      portraitInstructions: "private layer instruction",
    }),
  );
  expect(retry.status).toBe(303);
  admin = f.open();
  job = admin.nextJob()!;
  await loggedJob(job.requestId, { personaId: databasePersona.id }, admin.runNext, (entry) =>
    f.logs.push(entry),
  );
  const result = (await f.store.rigArtwork(databasePersona.id))!;
  expect(result.imageUrl).toBe(source.imageUrl);
  expect(result.layers!.layers).toHaveLength(2);
  expect(
    fetcher.mock.calls.filter(
      ([input, init]) =>
        fetchUrl(input).startsWith("https://queue.fal.run/") && init?.method === "POST",
    ),
  ).toHaveLength(1);
  f.state.saved!.drafts = [];
  admin = f.open();
  const restored = await (await admin(request(path))).text();
  expect(restored).toContain("레이어 2개 검수");
  const viewer = await admin(request(`${path}/artwork-layers`));
  expect(viewer.status).toBe(200);
  expect(await viewer.text()).toContain("Left arm");
  const metadata = await admin(request(`${path}/artwork-layers?download=1`));
  expect(metadata.headers.get("Cache-Control")).toBe("no-store");
  const exported = await metadata.text();
  expect(exported).not.toMatch(/private layer instruction|fal.media|layer-key|operationId/);
  expect(await f.store.get(databasePersona.id)).not.toHaveProperty("layers");
  expect(JSON.stringify(f.logs)).not.toContain("private layer instruction");
  expect(JSON.stringify(f.logs)).not.toContain("layer-key");
});
