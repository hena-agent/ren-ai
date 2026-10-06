import { expect, test, vi } from "vitest";
import { useBrowser, fillCharacterForm } from "../test/browser.ts";
import { bindPending } from "./pending.ts";
import { configureImageCount } from "./portrait-count-options.ts";
import {
  character,
  fixture,
  generator,
  newToken,
  portraitImage,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import { basePreview, preview, subGenerator } from "../test/sub-portraits.ts";

useBrowser();

test("count defaults to one and the modal displays the actual initial two-style total before confirmation", async () => {
  const { admin } = await fixture();
  document.body.innerHTML = await (await admin(request("/new"))).text();
  const form = fillCharacterForm(character);
  const dialog = form.querySelector<HTMLDialogElement>("dialog")!;
  const count = form.querySelector<HTMLSelectElement>('[name="imageCount"]')!;
  const button = form.querySelector<HTMLButtonElement>('[value="generate"]')!;
  bindPending(form);
  const sent: (FormDataEntryValue | null)[] = [];
  form.addEventListener("submit", (event) => {
    if (!event.defaultPrevented) {
      sent.push(new FormData(form).get("imageCount"));
      event.preventDefault();
    }
  });
  form.requestSubmit(button);
  expect(count.value).toBe("1");
  expect(dialog.querySelector("[data-image-total]")?.textContent).toBe(
    "애니메·실사 각각 1장 · 총 2장 생성",
  );
  count.value = "4";
  count.dispatchEvent(new Event("change"));
  expect(dialog.querySelector("[data-image-total]")?.textContent).toBe(
    "애니메·실사 각각 4장 · 총 8장 생성",
  );
  expect(sent).toEqual([]);
  dialog.querySelector<HTMLButtonElement>("[data-portrait-confirm]")!.click();
  expect(sent).toEqual(["4"]);
});

test("remaining capacity caps addition, regeneration is one, and repeated opening uses only the latest count context", () => {
  document.body.innerHTML =
    '<dialog><select name="imageCount"><option value="1">1</option><option value="2">2</option><option value="6">6</option></select><p data-image-total></p></dialog><button data-image-maximum="2"></button>';
  const dialog = document.querySelector("dialog")!;
  const button = document.querySelector("button")!;
  const count = dialog.querySelector("select")!;
  count.value = "6";
  configureImageCount(dialog, button, "subportrait");
  expect(count.value).toBe("1");
  expect(count.options[2]?.disabled).toBe(true);
  configureImageCount(dialog, button, "regenerate");
  expect(count.options[1]?.disabled).toBe(true);
  configureImageCount(dialog, button, "generate");
  count.value = "2";
  count.dispatchEvent(new Event("change"));
  expect(dialog.querySelector("p")?.textContent).toBe("애니메·실사 각각 2장 · 총 4장 생성");
});

test("only explicit larger counts create multiple photos; malformed counts never reach the provider", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, store } = await fixture({ ...subGenerator, portrait });
  const token = await newToken(admin);
  for (const imageCount of ["0", "7", "1.5", " 2", "-1"])
    expect(
      (
        await admin(
          request("/personas", { ...character, draft: token, intent: "generate", imageCount }),
        )
      ).status,
    ).toBe(400);
  expect(portrait).not.toHaveBeenCalled();
  const batch = await admin(
    request("/personas", { ...character, draft: token, intent: "generate", imageCount: "3" }),
  );
  expect(batch.status).toBe(200);
  const page = await batch.text();
  expect(portrait).toHaveBeenCalledTimes(6);
  expect(preview(page).secondaryPortraits).toHaveLength(4);
  const after = await admin(
    request("/personas?style=photo", {
      ...character,
      draft: tokenOf(page),
      intent: "subportrait",
      imageCount: "2",
    }),
  );
  expect(after.status).toBe(200);
  expect(portrait).toHaveBeenCalledTimes(8);
  expect(await store.list()).toEqual([]);
  expect(
    (
      await admin(
        request("/personas?image=0&style=photo", {
          ...character,
          draft: tokenOf(await after.text()),
          intent: "regenerate",
          imageCount: "2",
        }),
      )
    ).status,
  ).toBe(400);
});

test("a partially failed explicit batch keeps every successful photo without publishing unfinished edits", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, store } = await basePreview({ ...subGenerator, portrait });
  const before = preview(page);
  portrait
    .mockResolvedValueOnce(portraitImage)
    .mockRejectedValueOnce(new Error("second photo unavailable"))
    .mockResolvedValueOnce(portraitImage);
  const result = await admin(
    request("/personas?style=anime", {
      ...character,
      draft: tokenOf(page),
      intent: "subportrait",
      imageCount: "3",
    }),
  );
  expect(result.status).toBe(503);
  const partial = preview(await result.text());
  expect(partial.portraits).toEqual(before.portraits);
  expect(partial.secondaryPortraits).toHaveLength(2);
  expect(await store.publicList()).toEqual([]);
});

test("an explicitly selected initial batch preserves the successful style when its opposite main fails", async () => {
  const portrait = vi
    .fn<typeof generator.portrait>()
    .mockImplementation(async (_character, style) => {
      if (style === "photo") throw new Error("photo model unavailable");
      return portraitImage;
    });
  const { admin, store } = await fixture({ ...subGenerator, portrait });
  const result = await admin(
    request("/personas", {
      ...character,
      draft: await newToken(admin),
      intent: "generate",
      imageCount: "2",
    }),
  );
  expect(result.status).toBe(503);
  const partial = preview(await result.text());
  expect(partial.portraits?.anime).toBeTruthy();
  expect(partial.portraits?.photo).toBeUndefined();
  expect(partial.secondaryPortraits).toHaveLength(1);
  expect(await store.list()).toEqual([]);
});
