import { expect, test, vi } from "vitest";
import {
  character,
  generator,
  initialDocuments,
  newToken,
  photoPortrait,
  portraitImage,
  request,
  seedSheets,
  tokenOf,
} from "../test/fixtures.ts";
import { durableFixture } from "../test/durable-admin.ts";
import { databasePersona } from "../test/cloudflare-fixture.ts";
import { draftTokens } from "./draft.ts";
import { loggedJob } from "./logging.ts";
import { createRigArtworkGenerator } from "./rig-artwork-generation.ts";
import { durableArtworkFixture } from "../test/rig-artwork.ts";
import { fluxModel, seedreamModel, testImageConnections } from "../test/image-models.ts";

const tokens = draftTokens("test-password");
const submit = (draft: string) =>
  request("/personas", {
    ...character,
    draft,
    intent: "rig-artwork",
    rigArtworkModel: seedreamModel.id,
    imageCount: "1",
    portraitInstructions: "private artwork request",
  });

test("photo-only or foreign anime-sheet claims cannot generate an artwork", async () => {
  const { open, rigArtwork } = await durableArtworkFixture();
  const admin = open();
  const first = tokens.decode(await newToken(admin));
  const second = tokens.decode(await newToken(admin));
  const missing = tokens.encode({ ...first, sheets: { photo: first.sheets!.photo! } });
  expect((await admin(submit(missing))).status).toBe(400);
  const foreign = tokens.encode({
    ...first,
    sheets: { ...first.sheets, anime: second.sheets!.anime! },
  });
  expect((await admin(submit(foreign))).status).toBe(303);
  await loggedJob("foreign-sheet", {}, admin.runNext, () => {});
  expect(rigArtwork).not.toHaveBeenCalled();
});

test("actor replacement cannot make a queued artwork silently adopt a newer sheet", async () => {
  const { open, store, rigArtwork } = await durableArtworkFixture();
  let admin = open();
  const token = await newToken(admin);
  const draft = tokens.decode(token);
  await admin(submit(token));
  const replacement = await store.saveImage(photoPortrait);
  await store.saveSheet(draft.id, "anime", replacement, draft.sheets!.anime);
  admin = open();
  await loggedJob("changed-sheet", {}, admin.runNext, () => {});
  expect(rigArtwork).not.toHaveBeenCalled();
  expect(await store.rigArtwork(draft.id)).toBeUndefined();
});

test.each(["missing", "corrupt"])(
  "a %s sheet original blocks dispatch even if the signed URL still matches",
  async (failure) => {
    const { open, store, rigArtwork } = await durableArtworkFixture();
    const admin = open();
    const token = await newToken(admin);
    vi.spyOn(store, "image").mockImplementation(async () =>
      failure === "missing"
        ? new Response(null, { status: 404 })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    await admin(submit(token));
    await loggedJob("unreadable-sheet", {}, admin.runNext, () => {});
    expect(rigArtwork).not.toHaveBeenCalled();
  },
);

test("an old failed row cannot retry against a changed sheet; a fresh confirmed operation uses its new original", async () => {
  const rigArtwork = vi
    .fn<NonNullable<typeof generator.rigArtwork>>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(portraitImage);
  const { open, store } = await durableFixture({ ...generator, rigArtwork });
  await store.save(databasePersona, initialDocuments, { persona: "" });
  const sheets = await seedSheets(store, databasePersona.id);
  let admin = open();
  const path = `/personas/${databasePersona.id}`;
  const first = tokenOf(await (await admin(request(path))).text());
  const registered = await admin(
    request(path, {
      ...character,
      draft: first,
      intent: "rig-artwork",
      rigArtworkModel: seedreamModel.id,
      imageCount: "1",
    }),
  );
  await loggedJob("failed", {}, admin.runNext, () => {});
  const replacement = await store.saveImage(photoPortrait);
  await store.saveSheet(databasePersona.id, "anime", replacement, sheets.anime);
  admin = open();
  const current = tokenOf(await (await admin(request(path))).text());
  const retry = await admin(
    request(`${registered.headers.get("location")!}/retry?image=0`, {
      ...character,
      draft: current,
      portraitInstructions: "",
    }),
  );
  expect(retry.status).toBe(409);
  expect(rigArtwork).toHaveBeenCalledTimes(1);
  const fresh = await admin(
    request(path, {
      ...character,
      draft: current,
      intent: "rig-artwork",
      rigArtworkModel: fluxModel.id,
      imageCount: "1",
    }),
  );
  expect(fresh.status).toBe(303);
  await loggedJob("fresh-reference", {}, admin.runNext, () => {});
  expect(rigArtwork).toHaveBeenCalledTimes(2);
  expect(rigArtwork.mock.calls[1]![3]).toEqual(photoPortrait);
});

test("reference bytes and private text stay out of correlated provider failure diagnostics", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("private-key private artwork request", { status: 503 }));
  const { open, logs } = await durableFixture({
    ...generator,
    rigArtwork: createRigArtworkGenerator(testImageConnections, fetcher),
  });
  const admin = open();
  await admin(submit(await newToken(admin)));
  const job = admin.nextJob()!;
  await loggedJob(job.requestId, { jobId: job.id }, admin.runNext, (entry) => logs.push(entry));
  const failures = logs.filter((entry) => entry.event === "operation.failed" && entry.model);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({
    requestId: job.requestId,
    jobId: job.id,
    model: seedreamModel.id,
    status: 503,
    code: "http_error",
  });
  const output = JSON.stringify(logs);
  for (const secret of [
    "private-key",
    "private artwork request",
    character.description,
    portraitImage.bytes.toString("base64"),
  ])
    expect(output).not.toContain(secret);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
