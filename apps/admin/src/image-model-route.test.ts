import { Schema } from "effect";
import { expect, test, vi } from "vitest";
import {
  fixture,
  generator,
  character,
  newToken,
  portraitImage,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import { durableFixture } from "../test/durable-admin.ts";
import { createImageModelCatalog } from "./image-model-catalog.ts";
import { ImageModelPage, ImageModelSelection } from "./image-model.ts";
import {
  googleModel,
  openaiModel,
  modelCatalogFetch,
  modelsDevFixture,
  testImageConnections,
} from "../test/image-models.ts";
import { loggedJob } from "./logging.ts";
import { testImageModels } from "../test/image-models.ts";
import { fetchUrl } from "../test/fetch-url.ts";

const Detail = Schema.Struct({ selection: ImageModelSelection, quote: Schema.String });

test("authenticated catalog discovery returns model connection information without credentials", async () => {
  const { admin } = await fixture();
  expect((await admin(new Request("http://localhost:3729/image-models"))).status).toBe(401);
  const response = await admin(request("/image-models"));
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.clone().text();
  const page = Schema.decodeUnknownSync(ImageModelPage)(await response.json());
  expect(new Set(page.models.map((model) => model.provider)).size).toBe(4);
  for (const secret of Object.values(testImageConnections)) expect(text).not.toContain(secret);
  expect((await admin(request("/image-models", {}))).status).toBe(405);
  expect((await admin(request(`/image-models?q=${"a".repeat(201)}`))).status).toBe(400);
  expect((await admin(request("/image-models?model=invalid"))).status).toBe(400);
});

test("a future catalog model is confirmed, pinned through actor replacement and used without a model enum change", async () => {
  const payload = modelsDevFixture();
  const provider = payload["openai"]!;
  provider.models["next-image-2030"] = {
    ...provider.models[openaiModel.model]!,
    id: "next-image-2030",
    name: "Future image",
  };
  const metadata: typeof fetch = async (url, init) =>
    fetchUrl(url).includes("models.dev") ? Response.json(payload) : modelCatalogFetch(url, init);
  const imageModels = createImageModelCatalog(testImageConnections, "test-password", metadata);
  const rigArtwork = vi
    .fn<NonNullable<typeof generator.rigArtwork>>()
    .mockResolvedValue(portraitImage);
  const { open, state } = await durableFixture({ ...generator, imageModels, rigArtwork });
  let admin = open();
  const token = await newToken(admin);
  const chosen = await (
    await admin(request("/image-models?model=openai:next-image-2030"))
  )
    .json()
    .then(Schema.decodeUnknownSync(Detail));
  expect(rigArtwork).not.toHaveBeenCalled();
  const submission = request("/personas", {
    ...character,
    draft: token,
    intent: "rig-artwork",
    imageCount: "1",
    rigArtworkModel: chosen.selection.id,
    rigArtworkQuote: chosen.quote,
    portraitInstructions: "",
  });
  const registered = await admin(submission.clone());
  expect(registered.status).toBe(303);
  await admin(request("/image-models?refresh=1"));
  expect(state.saved!.queue.jobs[0]!.batch.original.rigArtwork!.selection).toEqual(
    chosen.selection,
  );
  admin = open();
  await loggedJob("future-model", {}, admin.runNext, () => {});
  expect(rigArtwork.mock.calls[0]![0]).toEqual(chosen.selection);
  const firstPage = await (await admin(request(registered.headers.get("location")!))).text();
  const next = await (
    await admin(request(`/image-models?model=${googleModel.id}`))
  )
    .json()
    .then(Schema.decodeUnknownSync(Detail));
  await admin(
    request("/personas", {
      ...character,
      draft: tokenOf(firstPage),
      intent: "rig-artwork",
      imageCount: "1",
      rigArtworkModel: next.selection.id,
      rigArtworkQuote: next.quote,
    }),
  );
  await loggedJob("google-model", {}, admin.runNext, () => {});
  expect(rigArtwork.mock.calls.map((call) => call[0].provider)).toEqual(["openai", "google"]);
  expect((await admin(submission.clone())).status).toBe(303);
  expect(rigArtwork).toHaveBeenCalledTimes(2);
});

test("forged or substituted catalog selection fails before queue registration", async () => {
  const rigArtwork = vi
    .fn<NonNullable<typeof generator.rigArtwork>>()
    .mockResolvedValue(portraitImage);
  const { open, state } = await durableFixture({ ...generator, rigArtwork });
  const admin = open();
  const token = await newToken(admin);
  const chosen = await (
    await admin(request(`/image-models?model=${googleModel.id}`))
  )
    .json()
    .then(Schema.decodeUnknownSync(Detail));
  const fields = {
    ...character,
    draft: token,
    intent: "rig-artwork",
    imageCount: "1",
    rigArtworkModel: googleModel.id,
    rigArtworkQuote: chosen.quote,
  };
  expect(
    (await admin(request("/personas", { ...fields, rigArtworkQuote: "tampered" }))).status,
  ).toBe(400);
  expect(
    (await admin(request("/personas", { ...fields, rigArtworkModel: openaiModel.id }))).status,
  ).toBe(400);
  expect(state.saved!.queue.jobs).toHaveLength(0);
  expect(rigArtwork).not.toHaveBeenCalled();
});

test("unconfigured and failed catalogs return correlated safe errors and bound pagination input", async () => {
  const { imageModels: _catalog, ...unconfigured } = generator;
  const missing = await fixture(unconfigured);
  expect((await missing.admin(request("/image-models"))).status).toBe(400);
  const broken = await fixture({
    ...generator,
    imageModels: {
      ...testImageModels,
      resolve: async () => {
        throw new Error("catalog storage offline");
      },
    },
  });
  const response = await broken.admin(request(`/image-models?model=${googleModel.id}`));
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(body).toContain(response.headers.get("x-request-id")!);
  expect(body).not.toContain("storage offline");
  expect((await broken.admin(request(`/image-models?cursor=${"a".repeat(1001)}`))).status).toBe(
    400,
  );
});
