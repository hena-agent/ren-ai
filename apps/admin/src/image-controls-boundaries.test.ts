import { expect, test } from "vitest";
import { bindPortraitDialog } from "./portrait-dialog.ts";
import { syncGender } from "./editor-controls.ts";
import { renderPage } from "./page.tsx";
import { useBrowser } from "../test/browser.ts";
import { femaleCharacter, fixture, legacy, request } from "../test/fixtures.ts";
import { basePreview } from "../test/sub-portraits.ts";
import copy from "./copy.json";
import { thumbnailUrl } from "@ren-ai/personas/image-url";

useBrowser();

test("a legacy picture exposes one URL-addressed image action in the editor, never on list cards", async () => {
  const { admin, store } = await fixture();
  await store.create(legacy);
  const path = `/personas/${legacy.id}`;
  document.body.innerHTML = await (await admin(request(path))).text();
  const image = document.querySelector<HTMLButtonElement>('[value="regenerate"]')!;
  expect(image.getAttribute("formaction")).toBe(
    `${path}?image=${encodeURIComponent(legacy.imageUrl)}&style=photo`,
  );
  expect(image.dataset["portraitOperation"]).toBe(`regenerate:photo:${legacy.imageUrl}`);
  expect(document.querySelector('[value="delete-image"]')?.getAttribute("formaction")).toBe(
    `${path}?image=${encodeURIComponent(legacy.imageUrl)}&style=photo`,
  );
  document.body.innerHTML = await (await admin(request("/"))).text();
  expect(document.querySelector('[value="regenerate"]')).toBeNull();
  document.body.innerHTML = renderPage({
    record: { ...legacy, description: "내부 설정", prompt: "내부 설정", bio: "", imageUrl: "" },
    editing: false,
    draft: "legacy",
  });
  expect(document.querySelector<HTMLSelectElement>("#gender")?.value).toBe("female");
  expect(
    new FormData(document.querySelector<HTMLFormElement>("#persona-editor")!).get("gender"),
  ).toBe("female");
  expect(document.querySelector('[value="subportrait"]')).toBeNull();
  expect(document.querySelector('[value="introduction"]')).toBeNull();
});

test("editing source leaves independent image actions available and partial gender markup is safe", async () => {
  const { page } = await basePreview();
  document.body.innerHTML = page;
  const form = document.querySelector<HTMLFormElement>("#persona-editor")!;
  form.querySelector<HTMLInputElement>('[name="name"]')!.value = "Edited";
  const description = form.querySelector<HTMLTextAreaElement>('[name="description"]')!;
  description.value = "New description";
  description.dispatchEvent(new Event("input"));
  expect(document.querySelector<HTMLButtonElement>('[value="generate"]')?.hidden).toBe(false);
  expect(
    [
      ...document.querySelectorAll<HTMLButtonElement>('[value="regenerate"], [value="generate"]'),
    ].every((button) => !button.disabled),
  ).toBe(true);
  document.body.innerHTML =
    '<select data-persona-gender><option value="female">Female</option></select><form></form>';
  expect(() => syncGender(document.querySelector("form")!)).not.toThrow();
  document.body.innerHTML = '<form><input name="gender" value="male"></form>';
  expect(() => syncGender(document.querySelector("form")!)).not.toThrow();
  expect(new FormData(document.querySelector("form")!).get("gender")).toBe("male");
});

test("cancelled same-target prompts survive reopening in a legacy dialog without a context paragraph", () => {
  document.body.innerHTML =
    '<form><dialog data-portrait-dialog><textarea></textarea><button type="button" data-portrait-cancel>Cancel</button><button type="button" data-portrait-confirm>Go</button></dialog><button value="regenerate" data-portrait-operation="image:photo">Image</button></form>';
  const form = document.querySelector("form")!;
  const dialog = form.querySelector("dialog")!;
  const input = dialog.querySelector("textarea")!;
  const button = form.querySelector<HTMLButtonElement>('[value="regenerate"]')!;
  bindPortraitDialog(form);
  form.requestSubmit(button);
  input.value = "draft";
  dialog.querySelector<HTMLButtonElement>("[data-portrait-cancel]")!.click();
  form.requestSubmit(button);
  expect(input.value).toBe("draft");
  expect(dialog.open).toBe(true);
});

test("server source state and style labels reflect independent main images accurately", () => {
  const source = {
    ...legacy,
    ...femaleCharacter,
    portraits: { anime: "https://example.net/anime.jpg", photo: legacy.imageUrl },
  };
  const cases = [
    { ...source, bio: "", imageUrl: "" },
    { ...source, imageUrl: "" },
    { ...source, bio: "" },
    source,
    { ...source, name: "Edited" },
  ];
  for (const record of cases) {
    document.body.innerHTML = renderPage({
      record,
      editing: true,
      draft: "signed",
    });
    expect(document.querySelector('[value="generate"]')?.hasAttribute("hidden")).toBe(false);
    expect(
      [...document.querySelectorAll(".image-regenerate")].map((button) =>
        button.getAttribute("data-portrait-label"),
      ),
    ).toEqual(
      ["photo", "anime"].map(
        (style) =>
          `사진 1 · ${copy.styles[style === "anime" ? "anime" : "photo"]} · ${copy.singleImageCost}`,
      ),
    );
  }
});

test("a saved partial style exposes only its remaining main image, and addition buttons encode their independent targets", async () => {
  document.body.innerHTML = renderPage({
    personas: [{ ...legacy, portraits: { photo: legacy.imageUrl } }],
  });
  expect(document.querySelectorAll("img")).toHaveLength(1);
  expect(document.querySelector(".portrait-anime")).toBeNull();
  const { page } = await basePreview();
  document.body.innerHTML = page;
  const buttons = document.querySelectorAll<HTMLButtonElement>('[value="generate"]');
  for (const [index, style] of ["photo", "anime"].entries()) {
    expect(buttons[index]?.getAttribute("formaction")).toBe(`/personas?style=${style}`);
    expect(buttons[index]?.dataset["portraitOperation"]).toBe(`generate:${style}`);
  }
  expect(document.querySelector('[value="introduction"]')).toBeNull();
  const image = document.querySelector<HTMLImageElement>("#portrait-gallery-anime img")!;
  const figure = image.closest("figure")!;
  const originalUrl = figure.querySelector("a")!.getAttribute("href")!;
  expect(image.getAttribute("src")).toBe(thumbnailUrl(originalUrl));
  const expectedTarget = `/personas?image=${encodeURIComponent(originalUrl)}&style=anime`;
  expect(figure.querySelector('[value="regenerate"]')?.getAttribute("formaction")).toBe(
    expectedTarget,
  );
  expect(figure.querySelector('[value="delete-image"]')?.getAttribute("formaction")).toBe(
    expectedTarget,
  );
  document.body.innerHTML = renderPage({
    record: { ...legacy, imageUrl: "" },
    editing: true,
    draft: "signed",
  });
  expect(document.querySelector('[value="generate"]')).toBeTruthy();
  expect(document.querySelector('[value="introduction"]')).toBeNull();
});
