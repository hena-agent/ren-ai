import { expect, test, vi } from "vitest";
import { createAdmin } from "./admin.ts";
import { draftTokens } from "./draft.ts";
import { personaImages } from "@ren-ai/personas";
import {
  character,
  femaleCharacter,
  fixture,
  generator,
  legacy,
  photoPortrait,
  portraitImage,
  request,
  tokenOf,
  newToken,
} from "../test/fixtures.ts";
import { preview, subGenerator } from "../test/sub-portraits.ts";
import { basePreview } from "../test/sub-portraits.ts";
import { queuedRequest, finishedJob, jobUrl } from "../test/queue.ts";

const sheetsOf = (page: string) => draftTokens("test-password").decode(tokenOf(page)).sheets!;

test("replacing a character draft invalidates both old identity sheets before any new photos", async () => {
  const { admin, store, page } = await basePreview();
  const id = preview(page).id;
  expect(Object.keys(await store.sheets(id))).toHaveLength(2);
  const replaced = await admin(
    request("/personas", { draft: tokenOf(page), intent: "character", seed: "a different person" }),
  );
  expect(replaced.status).toBe(200);
  const next = await replaced.text();
  expect(await store.sheets(id)).toEqual({});
  expect(preview(next).imageUrl).toBe("");
  expect(
    (await admin(request("/personas", { ...character, draft: tokenOf(next), intent: "generate" })))
      .status,
  ).toBe(400);
});

test("an older draft without identity sheets cannot borrow a newer preview's references", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockResolvedValue(portraitImage);
  const { admin } = await fixture({ ...generator, portrait });
  const token = await newToken(admin);
  await admin(request("/personas", { ...character, draft: token, intent: "generate" }));
  const tokens = draftTokens("test-password");
  const stale = { ...tokens.decode(token) };
  delete stale.sheets;
  const response = await admin(
    request("/personas?style=anime", {
      ...character,
      draft: tokens.encode(stale),
      intent: "generate",
    }),
  );
  expect(response.status).toBe(400);
  expect(portrait).toHaveBeenCalledTimes(1);
});

test("a signed draft cannot turn an external URL into an identity reference for paid generation", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockResolvedValue(portraitImage);
  const { admin } = await fixture({ ...generator, portrait });
  const tokens = draftTokens("test-password");
  const fresh = tokens.decode(tokenOf(await (await admin(request("/new"))).text()));
  const draft = tokens.encode({
    ...fresh,
    sheets: { anime: "https://example.net/unowned.jpg", photo: "https://example.net/unowned.jpg" },
  });
  expect(
    (await admin(request("/personas", { ...character, draft, intent: "generate" }))).status,
  ).toBe(400);
  expect(portrait).not.toHaveBeenCalled();
});

test("new personas start with two independently prompted sheets, auto-adopt them and only then generate gallery photos", async () => {
  const sheet = vi.fn<typeof generator.sheet>().mockImplementation(subGenerator.portrait);
  const portrait = vi.fn<typeof generator.portrait>().mockResolvedValue(portraitImage);
  const { admin, store, logs } = await fixture({ ...generator, sheet, portrait });
  const fresh = await (await admin(request("/new"))).text();
  expect(fresh).toContain("두 스타일 시트 만들기");
  const blocked = await admin(
    request("/personas", { ...character, draft: tokenOf(fresh), intent: "generate" }),
  );
  expect(blocked.status).toBe(400);
  expect(portrait).not.toHaveBeenCalled();
  const accepted = await admin(
    queuedRequest(
      "/personas",
      { ...character, draft: tokenOf(fresh), intent: "sheets", imageCount: "1" },
      ["private anime identity", "private photo identity"],
    ),
  );
  const path = jobUrl(accepted);
  const completed = await finishedJob(admin, path);
  expect(sheet.mock.calls).toEqual([
    [femaleCharacter, "anime", "private anime identity", undefined],
    [femaleCharacter, "photo", "private photo identity", undefined],
  ]);
  expect(portrait).not.toHaveBeenCalled();
  const record = preview(completed);
  const sheets = sheetsOf(completed);
  expect(await store.sheets(record.id)).toEqual(sheets);
  expect(personaImages(record)).toEqual([]);
  expect(await store.list()).toEqual([]);
  expect(completed).toContain("인물 시트");
  expect(
    (
      await admin(
        queuedRequest(
          "/personas",
          { ...character, draft: tokenOf(fresh), intent: "sheets", imageCount: "1" },
          ["private anime identity", "private photo identity"],
        ),
      )
    ).headers.get("location"),
  ).toBe(path);
  expect(sheet).toHaveBeenCalledTimes(2);
  const photos = await admin(
    request("/personas", { ...character, draft: tokenOf(completed), intent: "generate" }),
  );
  expect(photos.status).toBe(200);
  const page = await photos.text();
  expect(portrait.mock.calls.map((call) => call.slice(1))).toEqual([["photo", "", photoPortrait]]);
  expect(personaImages(preview(page))).toHaveLength(1);
  const saved = await admin(
    request("/personas", { ...character, draft: tokenOf(page), published: "on" }),
  );
  expect(saved.status).toBe(303);
  const publicData = JSON.stringify(await store.publicList());
  const source = await store.source(record.id);
  for (const url of Object.values(sheets)) {
    expect(source).not.toContain(url);
    expect(publicData).not.toContain(url);
  }
  expect(JSON.stringify(logs)).not.toContain("private anime identity");
  const restarted = createAdmin(store, "test-password", "", { generator, log: () => {} });
  const reopened = await (await restarted(request(`/personas/${record.id}`))).text();
  expect(sheetsOf(reopened)).toEqual(sheets);
});

test("existing photos can establish only their own style's sheet without changing any photo or publication", async () => {
  const sheet = vi.fn<typeof generator.sheet>().mockResolvedValue(photoPortrait);
  const portrait = vi.fn<typeof generator.portrait>().mockResolvedValue(photoPortrait);
  const { admin, store } = await fixture({ ...generator, sheet, portrait });
  const photo = await store.saveImage(portraitImage);
  await store.create({
    ...legacy,
    ...femaleCharacter,
    id: "existing",
    prompt: character.description,
    imageUrl: photo,
    portraits: { anime: photo },
  });
  const route = "/personas/existing";
  const editing = await (await admin(request(route))).text();
  for (const search of [
    "style=photo",
    "style=anime&image=https%3A%2F%2Fexample.net%2Fimage.jpg",
    `style=photo&image=${encodeURIComponent(photo)}`,
  ]) {
    expect(
      (
        await admin(
          request(`${route}?${search}`, {
            ...character,
            draft: tokenOf(editing),
            intent: search === "style=photo" ? "generate" : "sheet",
          }),
        )
      ).status,
    ).toBe(400);
  }
  const generated = await admin(
    request(`${route}?style=anime&image=${encodeURIComponent(photo)}`, {
      ...character,
      draft: tokenOf(editing),
      intent: "sheet",
      portraitInstructions: "private identity refinement",
    }),
  );
  expect(generated.status).toBe(200);
  const page = await generated.text();
  expect(sheet.mock.calls).toEqual([
    [femaleCharacter, "anime", "private identity refinement", portraitImage],
  ]);
  expect(personaImages(preview(page))).toEqual(personaImages(preview(editing)));
  expect((await store.get("existing")).portraits).toEqual({ anime: photo });
  expect(sheetsOf(page).photo).toBeUndefined();
  const added = await admin(
    request(`${route}?style=anime`, { ...character, draft: tokenOf(page), intent: "generate" }),
  );
  expect(added.status).toBe(200);
  expect(portrait.mock.calls[0]?.[3]).toEqual(photoPortrait);
  const replaced = await admin(
    request(`${route}?style=anime`, {
      ...character,
      draft: tokenOf(await added.text()),
      intent: "sheet",
    }),
  );
  expect(replaced.status).toBe(200);
  expect(sheet.mock.calls.at(-1)?.[3]).toBeUndefined();
  expect(personaImages(preview(await replaced.text()))).toHaveLength(2);
});

test("sheet replacement failure preserves the old reference and logs the failing task without leaking the prompt", async () => {
  const sheet = vi.fn<typeof generator.sheet>().mockResolvedValue(portraitImage);
  const { admin, store, logs } = await fixture({ ...generator, sheet });
  const first = await admin(
    request("/personas?style=anime", {
      ...character,
      draft: tokenOf(await (await admin(request("/new"))).text()),
      intent: "sheet",
    }),
  );
  const page = await first.text();
  const record = preview(page);
  const previous = await store.sheets(record.id);
  sheet.mockRejectedValue(new Error("provider unavailable"));
  const failed = await admin(
    request("/personas?style=anime", {
      ...character,
      draft: tokenOf(page),
      intent: "sheet",
      portraitInstructions: "private identity request",
    }),
  );
  expect(failed.status).toBe(503);
  expect(await store.sheets(record.id)).toEqual(previous);
  const diagnostics = logs.filter(
    (entry) =>
      entry.requestId === failed.headers.get("x-request-id") && entry.event === "operation.failed",
  );
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    stage: "identity.sheet.generate",
    style: "anime",
    error: { name: "Error", message: "provider unavailable" },
  });
  expect(JSON.stringify(logs)).not.toContain("private identity request");
});
