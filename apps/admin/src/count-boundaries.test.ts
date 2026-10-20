import { expect, test, vi } from "vitest";
import { useBrowser } from "../test/browser.ts";
import { configureImageCount } from "./portrait-count-options.ts";
import { photoVariation } from "./image-generation.ts";
import { character, generator, fixture, newToken, request, tokenOf } from "../test/fixtures.ts";
import { basePreview, preview, subGenerator, initialProfile } from "../test/sub-portraits.ts";
import copy from "./copy.json";

useBrowser();

test("all user-selected capture directions reach the image boundary in order, with no empty job or repeated main casting", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, logs } = await fixture({ ...subGenerator, portrait });
  const response = await admin(
    request("/personas", {
      ...character,
      draft: await newToken(admin),
      intent: "generate",
      imageCount: "6",
      portraitInstructions: "operator constraint",
    }),
  );
  expect(response.status).toBe(200);
  const result = preview(await response.text());
  expect(result.secondaryPortraits).toHaveLength(5);
  expect(portrait).toHaveBeenCalledTimes(6);
  const photos = portrait.mock.calls.filter((call) => call[1] === "photo");
  expect(photos.map((call) => call[2])).toEqual(
    Array.from(
      { length: 6 },
      (_, position) => `operator constraint\n\nPHOTO DIRECTION:\n${photoVariation(position)}`,
    ),
  );
  expect(photos.every((call) => Boolean(call[3]))).toBe(true);
  const directions = [0, 1, 2, 3, 4].map(photoVariation);
  expect(directions.every((direction) => direction.length > 40)).toBe(true);
  expect(directions[0]).toContain("selfie");
  expect(directions[1]).toContain("full-body");
  expect(directions[2]).toContain("everyday");
  expect(directions[3]).toContain("hobby");
  expect(directions[4]).toContain("new camera distance");
  expect(photoVariation(5)).toBe(directions[0]);
  const baseEvents = logs.filter(
    (entry) =>
      entry.stage === "portrait.generate" &&
      entry.event === "operation.completed" &&
      entry.poseIndex === 0,
  );
  expect(baseEvents).toHaveLength(1);
  for (const event of baseEvents) expect(event.jobId).toMatch(/^[0-9a-f-]{36}$/);
});

test("empty operator prompts do not prepend phantom scene separators, and batched fills can create a missing main", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, store } = await basePreview({ ...subGenerator, portrait });
  const created = preview(page);
  await store.create({
    ...created,
    portraits: { anime: created.portraits!.anime! },
    imageUrl: created.portraits!.anime!,
  });
  const route = `/personas/${created.id}`;
  const editing = await (await admin(request(route))).text();
  const count = portrait.mock.calls.length;
  const filled = await admin(
    request(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(editing),
      intent: "generate",
      imageCount: "2",
    }),
  );
  expect(filled.status).toBe(200);
  const after = preview(await filled.text());
  expect(after.portraits?.photo).toBeTruthy();
  expect(after.imageUrl).toBe(after.portraits?.photo);
  expect(after.secondaryPortraits).toHaveLength(1);
  expect(portrait.mock.calls.slice(count).map((call) => call[2])).toEqual([
    photoVariation(0),
    photoVariation(1),
  ]);
  expect(portrait.mock.calls[count]?.[3]).toEqual(portrait.mock.calls[count + 1]?.[3]);
  expect(portrait.mock.calls[count + 1]?.[3]).toBeTruthy();
});

test("an unreadable identity sheet prevents every photo in that style from generating unanchored", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, store, logs } = await fixture({ ...subGenerator, portrait });
  vi.spyOn(store, "image").mockResolvedValue(new Response(null, { status: 404 }));
  const failed = await initialProfile(admin, "2");
  expect(failed.status).toBe(503);
  const record = preview(await failed.text());
  expect(record.portraits).toBeUndefined();
  expect(record.secondaryPortraits).toBeUndefined();
  expect(portrait).not.toHaveBeenCalled();
  expect(
    logs.filter((entry) => entry.event === "operation.failed").map((entry) => entry.style),
  ).toEqual(["photo", "photo"]);
});

test("whole initial failure returns a correlated recovery page while an explicit extra-image failure retains successful outputs", async () => {
  const portrait = vi
    .fn<typeof generator.portrait>()
    .mockRejectedValue(new Error("provider outage"));
  const { admin } = await fixture({ ...subGenerator, portrait });
  const failed = await initialProfile(admin, "2");
  expect(failed.status).toBe(503);
  const html = await failed.text();
  expect(html).toContain("완성된 사진은 미리보기에 보존");
  expect(html).toContain(failed.headers.get("x-request-id"));
  expect(preview(html).imageUrl).toBe("");
  expect(html).toContain(`value="${character.name}"`);
});

test("a failed optional whole-photo batch still permits saving the edited source with retained photos", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, store } = await basePreview({ ...subGenerator, portrait });
  portrait.mockRejectedValue(new Error("outage"));
  const changed = {
    ...character,
    name: "Changed source",
    draft: tokenOf(page),
    intent: "generate",
    imageCount: "2",
  };
  const failed = await admin(request("/personas", changed));
  expect(failed.status).toBe(503);
  const html = await failed.text();
  expect(preview(html)).toEqual({ ...preview(page), name: "Changed source" });
  expect(html).toContain('value="Changed source"');
  expect(
    (await admin(request("/personas", { ...changed, draft: tokenOf(html), intent: "save" })))
      .status,
  ).toBe(303);
  expect((await store.get(preview(page).id)).name).toBe("Changed source");
  expect((await store.get(preview(page).id)).portraits).toEqual(preview(page).portraits);
});

test("modal count caps, totals and updates respect initial, additional and one-image regeneration contexts", () => {
  document.body.innerHTML =
    '<dialog><select name="imageCount"><option value="1">1</option><option value="2">2</option><option value="6">6</option></select><p data-image-total></p></dialog><button></button>';
  const dialog = document.querySelector("dialog")!;
  const select = dialog.querySelector("select")!;
  const button = document.querySelector("button")!;
  configureImageCount(dialog, button, "generate");
  expect(dialog.querySelector("p")?.textContent).toBe("선택한 스타일 1장 생성");
  select.value = "6";
  select.dispatchEvent(new Event("change"));
  expect(dialog.querySelector("p")?.textContent).toBe("선택한 스타일 6장 생성");
  expect(select.options[2]?.disabled).toBe(false);
  configureImageCount(dialog, button, "generate");
  expect(select.value).toBe("6");
  button.dataset["imageMaximum"] = "2";
  configureImageCount(dialog, button, "generate");
  expect(select.value).toBe("1");
  select.value = "2";
  select.dispatchEvent(new Event("change"));
  expect(dialog.querySelector("p")?.textContent).toBe("선택한 스타일 2장 생성");
  expect(select.options[1]?.disabled).toBe(false);
  configureImageCount(dialog, button, "regenerate");
  expect(select.value).toBe("1");
  expect(select.options[1]?.disabled).toBe(true);
  dialog.querySelector("p")!.remove();
  expect(() => configureImageCount(dialog, button, "generate")).not.toThrow();
  document.body.innerHTML = "<dialog></dialog>";
  expect(() =>
    configureImageCount(document.querySelector("dialog")!, button, "generate"),
  ).not.toThrow();
});

test("uploaded counts are rejected before paid work, and failed secondary outputs never discard successful initial photos", async () => {
  vi.unstubAllGlobals();
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin } = await fixture({ ...subGenerator, portrait });
  const token = await newToken(admin);
  const form = new FormData();
  for (const [key, value] of Object.entries({ ...character, draft: token, intent: "generate" }))
    form.set(key, value);
  form.set("imageCount", new File(["2"], "count.txt"));
  const rejected = await admin(
    new Request(request("/personas?style=photo"), { method: "POST", body: form }),
  );
  expect(rejected.status).toBe(400);
  expect(await rejected.text()).toContain(copy.formError);
  expect(portrait).not.toHaveBeenCalled();
  portrait
    .mockResolvedValueOnce({ bytes: Buffer.from("89504e470d0a1a0a", "hex"), mimeType: "image/png" })
    .mockImplementationOnce(subGenerator.portrait)
    .mockRejectedValueOnce(new Error("secondary outage"));
  const partial = await admin(
    request("/personas", { ...character, draft: token, intent: "generate", imageCount: "3" }),
  );
  expect(partial.status).toBe(503);
  const record = preview(await partial.text());
  expect(record.portraits?.anime).toBeUndefined();
  expect(record.portraits?.photo).toBeTruthy();
  expect(record.secondaryPortraits).toHaveLength(1);
  expect(portrait.mock.calls[0]?.[2]).toBe(photoVariation(0));
  expect(portrait.mock.calls[2]?.[2]).toBe(photoVariation(2));
});
