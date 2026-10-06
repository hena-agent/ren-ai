import { expect, test, vi } from "vitest";
import { personaImages } from "@ren-ai/personas";
import { character, fixture, generator, legacy, request, tokenOf } from "../test/fixtures.ts";
import {
  basePreview,
  preview,
  subGenerator,
  photoPortrait,
  addPortrait,
  savedPreview,
} from "../test/sub-portraits.ts";
import { createAdmin } from "./admin.ts";
import { useBrowser } from "../test/browser.ts";
import { bindPending } from "./pending.ts";

useBrowser();

function openPhotoAddition(page: string) {
  document.body.innerHTML = page;
  const form = document.querySelector<HTMLFormElement>("#persona-editor")!;
  bindPending(form);
  form.requestSubmit(
    form.querySelector<HTMLButtonElement>('[value="subportrait"][formaction$="photo"]'),
  );
  return form;
}

test("stale forms preserve newer deletions and additions, and deleted image targets are safe to replay", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page } = await basePreview({ ...subGenerator, portrait });
  const record = preview(page);
  const main = record.portraits!.photo!;
  const added = await (await addPortrait(admin, page)).text();
  const beforeDelete = preview(added);
  const fields = { ...character, draft: tokenOf(page), intent: "delete-image" };
  const route = `/personas?style=photo&image=${encodeURIComponent(main)}`;
  const deleted = await (await admin(request(route, fields))).text();
  expect(preview(deleted).portraits?.photo).toBe(beforeDelete.secondaryPortraits?.[0]?.imageUrl);
  const replay = await admin(request(route, fields));
  expect(replay.status).toBe(200);
  expect(preview(await replay.text())).toEqual(preview(deleted));
  const regeneratedReplay = await admin(request(route, { ...fields, intent: "regenerate" }));
  expect(regeneratedReplay.status).toBe(200);
  expect(preview(await regeneratedReplay.text())).toEqual(preview(deleted));
  expect(portrait).toHaveBeenCalledTimes(3);
});

test("stale secondary regeneration is rejected when its identity main was changed", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page } = await basePreview({ ...subGenerator, portrait });
  const added = await (
    await admin(
      request("/personas?style=photo", {
        ...character,
        draft: tokenOf(page),
        intent: "subportrait",
      }),
    )
  ).text();
  const original = preview(added);
  await admin(
    request(`/personas?style=photo&image=${encodeURIComponent(original.portraits!.photo!)}`, {
      ...character,
      draft: tokenOf(added),
      intent: "regenerate",
    }),
  );
  const stale = await admin(
    request(
      `/personas?style=photo&image=${encodeURIComponent(original.secondaryPortraits![0]!.imageUrl)}`,
      { ...character, draft: tokenOf(added), intent: "regenerate" },
    ),
  );
  expect(stale.status).toBe(409);
  expect(portrait).toHaveBeenCalledTimes(4);
});

test("secondary regeneration passes both same-style identity and current composition while deleting extras retains all others", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page } = await basePreview({ ...subGenerator, portrait });
  let current = page;
  for (const style of ["anime", "photo"])
    current = await (
      await admin(
        request(`/personas?style=${style}`, {
          ...character,
          draft: tokenOf(current),
          intent: "subportrait",
          imageCount: "2",
        }),
      )
    ).text();
  const before = preview(current);
  const target = before.secondaryPortraits!.find((image) => image.style === "photo")!;
  const replacement = await (
    await admin(
      request(`/personas?style=photo&image=${encodeURIComponent(target.imageUrl)}`, {
        ...character,
        draft: tokenOf(current),
        intent: "regenerate",
      }),
    )
  ).text();
  expect(portrait.mock.calls.at(-1)?.slice(3)).toEqual([photoPortrait, photoPortrait]);
  expect(preview(replacement).imageUrl).toBe(before.imageUrl);
  const changedPhoto = preview(replacement).secondaryPortraits!.find(
    (image) => image.style === "photo",
  )!.imageUrl;
  const removed = await (
    await admin(
      request(`/personas?style=photo&image=${encodeURIComponent(changedPhoto)}`, {
        ...character,
        draft: tokenOf(replacement),
        intent: "delete-image",
        published: "on",
      }),
    )
  ).text();
  expect(personaImages(preview(removed))).toHaveLength(5);
  expect(preview(removed).published).toBe(true);
  expect(preview(removed).portraits).toEqual(before.portraits);
});

test("a last-photo deletion becomes unpublished and restart-without-cache editing remains usable", async () => {
  const { admin, store } = await fixture();
  await store.create(legacy);
  const route = `/personas/${legacy.id}`;
  const page = await (await admin(request(route))).text();
  const fresh = createAdmin(store, "test-password", "", { generator: subGenerator, log: () => {} });
  const deleted = await fresh(
    request(`${route}?style=photo&image=0`, {
      name: legacy.name,
      description: legacy.prompt,
      draft: tokenOf(page),
      intent: "delete-image",
      published: "on",
    }),
  );
  expect(deleted.status).toBe(200);
  const record = preview(await deleted.text());
  expect(record.imageUrl).toBe("");
  expect(record.published).toBe(false);
  expect(personaImages(record)).toEqual([]);
});

test("an older saved form cannot consume regeneration work after a newer preview was saved", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, store } = await basePreview({ ...subGenerator, portrait });
  const original = preview(page);
  await store.create(original);
  const route = `/personas/${original.id}`;
  const editing = await (await admin(request(route))).text();
  const query = `${route}?style=photo&image=${encodeURIComponent(original.portraits!.photo!)}`;
  const fields = { ...character, draft: tokenOf(editing), intent: "regenerate" };
  const replaced = await (await admin(request(query, fields))).text();
  expect(
    (await admin(request(route, { ...character, draft: tokenOf(replaced), intent: "save" })))
      .status,
  ).toBe(303);
  const replay = await admin(request(query, fields));
  expect(replay.status).toBe(200);
  expect(preview(await replay.text())).toEqual(await store.get(original.id));
  expect(portrait).toHaveBeenCalledTimes(3);
});

test("count and prompt are scoped to a failed target, with the next target returning to one and a blank prompt", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page } = await basePreview({ ...subGenerator, portrait });
  portrait.mockRejectedValue(new Error("outage"));
  const failed = await admin(
    request("/personas?style=photo", {
      ...character,
      draft: tokenOf(page),
      intent: "subportrait",
      imageCount: "2",
      portraitInstructions: "retry this",
    }),
  );
  document.body.innerHTML = await failed.text();
  const form = document.querySelector<HTMLFormElement>("#persona-editor")!;
  bindPending(form);
  const dialog = form.querySelector<HTMLDialogElement>("dialog")!;
  const count = dialog.querySelector<HTMLSelectElement>("select")!;
  const buttons = form.querySelectorAll<HTMLButtonElement>('[value="subportrait"]');
  const cancel = dialog.querySelector<HTMLButtonElement>("[data-portrait-cancel]")!;
  form.requestSubmit(buttons[1]);
  expect(count.value).toBe("2");
  expect(dialog.querySelector("textarea")?.value).toBe("retry this");
  expect(dialog.querySelector("[data-portrait-target]")?.textContent).toContain("실사");
  cancel.click();
  form.requestSubmit(buttons[0]);
  expect(count.value).toBe("1");
  expect(dialog.querySelector("textarea")?.value).toBe("");
});

test("a fresh action after a successful batch defaults to one and an empty prompt, including after reload", async () => {
  const { admin, page, store } = await basePreview();
  const record = preview(page);
  await store.create(record);
  const route = `/personas/${record.id}`;
  const editing = await (await admin(request(route))).text();
  const added = await admin(
    request(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(editing),
      intent: "subportrait",
      imageCount: "2",
      portraitInstructions: "for this batch only",
    }),
  );
  expect(added.status).toBe(200);
  for (const content of [await added.text(), await (await admin(request(route))).text()]) {
    const form = openPhotoAddition(content);
    expect(form.querySelector<HTMLSelectElement>('[name="imageCount"]')?.value).toBe("1");
    expect(form.querySelector<HTMLTextAreaElement>('[name="portraitInstructions"]')?.value).toBe(
      "",
    );
  }
});

test("completed partial photos are shown in the response, and a no-op image replay uses signed publication state", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page } = await basePreview({ ...subGenerator, portrait });
  portrait.mockRejectedValueOnce(new Error("one image unavailable"));
  const failed = await addPortrait(admin, page, "photo", "3");
  expect(failed.status).toBe(503);
  const content = await failed.text();
  document.body.innerHTML = content;
  expect(document.querySelectorAll(".image-option img")).toHaveLength(
    personaImages(preview(content)).length,
  );
  expect(document.querySelectorAll(".image-option img")).toHaveLength(4);
  const old = preview(content).portraits!.anime!;
  const deleted = await (
    await admin(
      request(`/personas?style=anime&image=${encodeURIComponent(old)}`, {
        ...character,
        draft: tokenOf(content),
        intent: "delete-image",
        published: "on",
      }),
    )
  ).text();
  const replay = await (
    await admin(
      request(`/personas?style=anime&image=${encodeURIComponent(old)}`, {
        ...character,
        draft: tokenOf(content),
        intent: "regenerate",
      }),
    )
  ).text();
  expect(preview(replay)).toEqual(preview(deleted));
  document.body.innerHTML = replay;
  expect(document.querySelector<HTMLInputElement>("#published")?.checked).toBe(true);
});

test("reload retains partial profile creation and failed same-style addition input rather than falling back to the saved photos", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, route, editing } = await savedPreview({ ...subGenerator, portrait });
  portrait.mockRejectedValueOnce(new Error("one style unavailable"));
  const partial = await admin(
    request(route, { ...character, draft: tokenOf(editing), intent: "generate", imageCount: "2" }),
  );
  expect(partial.status).toBe(503);
  const completed = await partial.text();
  expect(preview(await (await admin(request(route))).text())).toEqual(preview(completed));
  expect(
    (await admin(request(route, { ...character, draft: tokenOf(completed), intent: "save" })))
      .status,
  ).toBe(303);
  const current = await (await admin(request(route))).text();
  portrait.mockRejectedValue(new Error("outage"));
  expect(
    (
      await admin(
        request(`${route}?style=photo`, {
          ...character,
          draft: tokenOf(current),
          intent: "subportrait",
          imageCount: "2",
          portraitInstructions: "keep this retry",
        }),
      )
    ).status,
  ).toBe(503);
  const form = openPhotoAddition(await (await admin(request(route))).text());
  expect(form.querySelector<HTMLSelectElement>('[name="imageCount"]')?.value).toBe("2");
  expect(form.querySelector<HTMLTextAreaElement>('[name="portraitInstructions"]')?.value).toBe(
    "keep this retry",
  );
});

test("whole-image regeneration follows its signed original biography instead of borrowing an unrelated newer text draft", async () => {
  const introduction = vi
    .fn<typeof generator.introduction>()
    .mockImplementation(generator.introduction);
  const { admin, page } = await basePreview({ ...subGenerator, introduction });
  introduction.mockResolvedValueOnce("A newly edited public introduction.");
  const rewritten = await admin(
    request("/personas", { ...character, draft: tokenOf(page), intent: "introduction" }),
  );
  expect(preview(await rewritten.text()).bio).not.toBe(preview(page).bio);
  const portraitOnly = await admin(
    request("/personas", { ...character, draft: tokenOf(page), intent: "portrait" }),
  );
  expect(portraitOnly.status).toBe(200);
  expect(preview(await portraitOnly.text()).bio).toBe(preview(page).bio);
});
