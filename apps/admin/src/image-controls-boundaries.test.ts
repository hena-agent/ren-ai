import { expect, test } from "vitest";
import { bindPortraitDialog } from "./portrait-dialog.ts";
import { syncGender, bindProfileSource } from "./editor-controls.ts";
import { renderPage } from "./page.tsx";
import { useBrowser } from "../test/browser.ts";
import { character, femaleCharacter, fixture, legacy, request, tokenOf } from "../test/fixtures.ts";
import { basePreview } from "../test/sub-portraits.ts";
import copy from "./copy.json";

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
    record: { ...legacy, bio: "", imageUrl: "" },
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

test("dirty source initializes before typing; surrounding whitespace and partial gender markup are safe", async () => {
  const { admin, page } = await basePreview();
  const failed = await admin(
    request("/personas?image=0&style=photo", {
      ...character,
      name: "Edited",
      draft: tokenOf(page),
      intent: "regenerate",
    }),
  );
  document.body.innerHTML = await failed.text();
  const form = document.querySelector<HTMLFormElement>("#persona-editor")!;
  bindProfileSource(form);
  expect(
    [...document.querySelectorAll<HTMLButtonElement>("[data-source-bound]")].every(
      (button) => button.disabled,
    ),
  ).toBe(true);
  form.querySelector<HTMLInputElement>('[name="name"]')!.value = `  ${character.name}  `;
  const description = form.querySelector<HTMLTextAreaElement>('[name="description"]')!;
  description.value = `  ${character.description}  `;
  description.dispatchEvent(new Event("input"));
  expect(form.querySelector<HTMLButtonElement>('[value="generate"]')?.hidden).toBe(true);
  expect(
    [...document.querySelectorAll<HTMLButtonElement>("[data-source-bound]")].every(
      (button) => !button.disabled,
    ),
  ).toBe(true);
  description.value = "New description";
  description.dispatchEvent(new Event("input"));
  expect(form.querySelector<HTMLButtonElement>('[value="generate"]')?.hidden).toBe(false);
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
    { record: { ...source, bio: "", imageUrl: "" }, complete: false, hidden: false },
    { record: { ...source, imageUrl: "" }, complete: false, hidden: false },
    { record: { ...source, bio: "" }, complete: false, hidden: false },
    { record: source, complete: true, hidden: true },
    { record: { ...source, name: "Edited" }, complete: true, hidden: false },
  ];
  for (const [index, current] of cases.entries()) {
    document.body.innerHTML = renderPage({
      record: current.record,
      profileSource: index === 4 ? source : current.record,
      editing: true,
      draft: "signed",
    });
    expect(document.querySelector("#persona-editor")?.getAttribute("data-profile-complete")).toBe(
      String(current.complete),
    );
    expect(document.querySelector('[value="generate"]')?.hasAttribute("hidden")).toBe(
      current.hidden,
    );
    expect(
      [...document.querySelectorAll(".image-regenerate")].map((button) =>
        button.getAttribute("data-portrait-label"),
      ),
    ).toEqual(
      ["anime", "photo"].map(
        (style) =>
          `${copy.mainImage} · ${copy.styles[style === "anime" ? "anime" : "photo"]} · ${copy.singleImageCost}`,
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
  const buttons = document.querySelectorAll<HTMLButtonElement>('[value="subportrait"]');
  for (const [index, style] of ["anime", "photo"].entries()) {
    expect(buttons[index]?.getAttribute("formaction")).toBe(`/personas?style=${style}`);
    expect(buttons[index]?.dataset["portraitOperation"]).toBe(`subportrait:${style}`);
  }
  expect(document.querySelector('[value="introduction"]')?.textContent).toBe(
    copy.regenerateIntroduction,
  );
  const image = document.querySelector<HTMLImageElement>(".image-option img")!;
  const originalUrl = image.getAttribute("src")!.replace(/^\/images\//, "/discovery/images/");
  const expectedTarget = `/personas?image=${encodeURIComponent(originalUrl)}&style=anime`;
  const figure = image.closest("figure")!;
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
  expect(document.querySelector('[value="subportrait"]')).toBeTruthy();
  expect(document.querySelector('[value="introduction"]')).toBeTruthy();
});
