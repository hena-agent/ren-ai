import { expect, test, vi } from "vitest";
import {
  character,
  generator,
  initialDocuments,
  newToken,
  portraitImage,
  request,
  tokenOf,
  seedSheets,
} from "../test/fixtures.ts";
import { durableFixture } from "../test/durable-admin.ts";
import { databasePersona } from "../test/cloudflare-fixture.ts";
import { draftTokens } from "./draft.ts";
import { loggedJob } from "./logging.ts";
import type { createAdmin } from "./admin.ts";
import { serializePersona } from "@ren-ai/personas";
import { splitPersonaMarkdown } from "@ren-ai/personas/profile";
import { durableArtworkFixture } from "../test/rig-artwork.ts";
import { fluxModel, seedreamModel } from "../test/image-models.ts";

const tokens = draftTokens("test-password");
const form = (draft: string, model = seedreamModel.id) => ({
  ...character,
  draft,
  intent: "rig-artwork",
  rigArtworkModel: model,
  portraitInstructions: "private optional request",
  imageCount: "1",
});
const step = (admin: ReturnType<typeof createAdmin>) =>
  loggedJob(admin.nextJob()!.requestId, {}, admin.runNext, () => {});

test("each persona owns one artwork; models switch on replacement and saving/restart keeps it outside galleries and public data", async () => {
  const { store, open, state, rigArtwork } = await durableArtworkFixture();
  await store.save(databasePersona, initialDocuments, { persona: "" });
  await seedSheets(store, databasePersona.id);
  let admin = open();
  const path = `/personas/${databasePersona.id}`;
  const original = await store.get(databasePersona.id);
  const before = tokenOf(await (await admin(request(path))).text());
  expect((await admin(request(path, form(before)))).status).toBe(303);
  admin = open();
  await step(admin);
  const first = tokenOf(await (await admin(request(path))).text());
  const firstUrl = tokens.decode(first).rigArtwork!.image!.imageUrl;
  expect(rigArtwork.mock.calls[0]![1]).toBe(
    `${character.name}\n${splitPersonaMarkdown(character.description).privateMarkdown}`,
  );
  expect(rigArtwork.mock.calls[0]![3]).toEqual(portraitImage);
  expect(tokens.decode(first).id).toBe(databasePersona.id);
  const replacement = request(path, form(first, fluxModel.id));
  await admin(replacement.clone());
  await admin(replacement.clone());
  await step(admin);
  const complete = tokenOf(await (await admin(request(path))).text());
  expect(tokens.decode(complete).rigArtwork!.image).toMatchObject({ model: fluxModel.id });
  expect(tokens.decode(complete).rigArtwork!.image!.imageUrl).not.toBe(firstUrl);
  expect(rigArtwork).toHaveBeenCalledTimes(2);
  const saved = await admin(request(path, { ...character, draft: complete, intent: "save" }));
  expect(saved.status).toBe(303);
  // Losing private editing drafts must not lose the persona's current source artwork.
  state.saved!.drafts = [];
  admin = open();
  const reopened = tokens.decode(tokenOf(await (await admin(request(path))).text()));
  expect(reopened.rigArtwork!.image).toEqual(tokens.decode(complete).rigArtwork!.image);
  const persona = await store.get(databasePersona.id);
  expect(persona.imageUrl).toBe(original.imageUrl);
  expect(persona.secondaryPortraits).toEqual(original.secondaryPortraits);
  expect(JSON.stringify(persona)).not.toContain("rigArtwork");
  expect(JSON.stringify(await store.publicList())).not.toContain("rigArtwork");
  expect((await admin(request("/rig-artworks"))).status).toBe(404);
});

test("a failed replacement preserves the current artwork and confirmed row retry retains the selected model", async () => {
  const rigArtwork = vi
    .fn<NonNullable<typeof generator.rigArtwork>>()
    .mockResolvedValueOnce(portraitImage)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(portraitImage);
  const { open } = await durableFixture({ ...generator, rigArtwork });
  let admin = open();
  const token = await newToken(admin);
  const registered = await admin(request("/personas", form(token)));
  const firstUrl = registered.headers.get("location")!;
  await step(admin);
  const first = tokenOf(await (await admin(request(firstUrl))).text());
  const original = tokens.decode(first).rigArtwork!.image!;
  const replacing = await admin(request("/personas", form(first, fluxModel.id)));
  const jobUrl = replacing.headers.get("location")!;
  await step(admin);
  admin = open();
  const failed = tokenOf(await (await admin(request(jobUrl))).text());
  expect(tokens.decode(failed).rigArtwork!.image).toEqual(original);
  const retry = await admin(
    request(`${jobUrl}/retry?image=0`, {
      ...character,
      draft: failed,
      portraitInstructions: "retry direction",
    }),
  );
  expect(retry.status).toBe(303);
  await step(admin);
  const completed = tokenOf(await (await admin(request(jobUrl))).text());
  expect(tokens.decode(completed).rigArtwork!.image!.model).toBe(fluxModel.id);
  expect(tokens.decode(completed).rigArtwork!.image!.imageUrl).not.toBe(original.imageUrl);
  expect(rigArtwork).toHaveBeenCalledTimes(3);
  expect(rigArtwork.mock.calls[2]![0].id).toBe(fluxModel.id);
  expect(rigArtwork.mock.calls[2]![2]).toBe("retry direction");
});

test("pending artwork locks competing work for the same persona, leaves other personas independent and rejects multiple-image/model bypasses", async () => {
  const { open, rigArtwork } = await durableArtworkFixture();
  const admin = open();
  const first = await newToken(admin);
  const second = await newToken(admin);
  for (const invalid of [
    { ...form(first), imageCount: "2" },
    { ...form(first), rigArtworkModel: "arbitrary" },
  ])
    expect((await admin(request("/personas", invalid))).status).toBe(400);
  expect((await admin(request("/personas", form(first)))).status).toBe(303);
  expect((await admin(request("/personas", form(first, fluxModel.id)))).status).toBe(409);
  expect(
    (await admin(request("/personas", { ...character, draft: first, intent: "generate" }))).status,
  ).toBe(409);
  expect((await admin(request("/personas", form(second, fluxModel.id)))).status).toBe(303);
  await step(admin);
  await step(admin);
  expect(rigArtwork.mock.calls.map((call) => call[0].id)).toEqual([seedreamModel.id, fluxModel.id]);
});

test("artwork uses the current edited persona description and refuses a stale saved source before the next paid call", async () => {
  const { open, store, rigArtwork } = await durableArtworkFixture();
  await store.save(databasePersona, initialDocuments, { persona: "" });
  await seedSheets(store, databasePersona.id);
  const admin = open();
  const path = `/personas/${databasePersona.id}`;
  const token = tokenOf(await (await admin(request(path))).text());
  const description = character.description.replace("짧은 검은 머리", "긴 은발");
  const registered = await admin(request(path, { ...form(token), description }));
  await step(admin);
  expect(rigArtwork.mock.calls[0]![1]).toBe(
    `${character.name}\n${splitPersonaMarkdown(description).privateMarkdown}`,
  );
  const current = tokenOf(await (await admin(request(registered.headers.get("location")!))).text());
  await admin(request(path, { ...form(current, fluxModel.id), description }));
  const before = await store.get(databasePersona.id);
  await store.save({ ...before, language: "en" }, initialDocuments, {
    persona: serializePersona(before),
    initial: initialDocuments,
  });
  await step(admin);
  expect(rigArtwork).toHaveBeenCalledTimes(1);
  expect((await store.rigArtwork(databasePersona.id))!.model).toBe(seedreamModel.id);
});
