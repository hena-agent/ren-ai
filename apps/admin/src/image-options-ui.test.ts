import { expect, test, vi } from "vitest";
import { useBrowser } from "../test/browser.ts";
import { character, generator, request, tokenOf } from "../test/fixtures.ts";
import { basePreview, subGenerator } from "../test/sub-portraits.ts";
import { bindPending } from "./pending.ts";
import copy from "./copy.json";

useBrowser();

function bind(page: string) {
  document.body.innerHTML = page;
  const form = document.querySelector<HTMLFormElement>("#persona-editor")!;
  const dialog = form.querySelector<HTMLDialogElement>("dialog")!;
  const prompt = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
  const calls: string[] = [];
  bindPending(form);
  form.addEventListener("submit", (event) => {
    if (!event.defaultPrevented) {
      calls.push(prompt.value);
      event.preventDefault();
    }
  });
  return {
    form,
    dialog,
    prompt,
    calls,
    confirm: dialog.querySelector<HTMLButtonElement>("[data-portrait-confirm]")!,
    cancel: dialog.querySelector<HTMLButtonElement>("[data-portrait-cancel]")!,
  };
}

test("additional-image generation requires confirmation and switching to an image starts blank", async () => {
  const { page } = await basePreview();
  const ui = bind(page);
  const suggested = document.querySelector<HTMLButtonElement>(
    '.sub-portraits [value="subportrait"]',
  )!;
  const image = document.querySelector<HTMLButtonElement>(".image-regenerate")!;
  ui.form.requestSubmit(suggested);
  expect(ui.dialog.open).toBe(true);
  expect(new FormData(ui.form).get("imageDirection")).toBeNull();
  ui.prompt.value = "optional";
  ui.cancel.click();
  expect(ui.calls).toEqual([]);
  ui.form.requestSubmit(image);
  expect(ui.prompt.value).toBe("");
  expect(new FormData(ui.form).get("imageDirection")).toBeNull();
  ui.confirm.click();
  expect(ui.calls).toEqual([""]);
  expect(ui.form.querySelector("[data-pending]")?.textContent).toBe(copy.regeneratingImage);
});

test("a failed same-image retry keeps its extra prompt and another target clears it", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page } = await basePreview({ ...subGenerator, portrait });
  portrait.mockRejectedValueOnce(new Error("offline"));
  const failed = await admin(
    request("/personas?image=0&style=photo", {
      ...character,
      draft: tokenOf(page),
      intent: "regenerate",
      portraitInstructions: "retry instruction",
    }),
  );
  const ui = bind(await failed.text());
  const buttons = document.querySelectorAll<HTMLButtonElement>(".image-regenerate");
  ui.form.requestSubmit(buttons[1]);
  expect(ui.prompt.value).toBe("retry instruction");
  ui.cancel.click();
  ui.form.requestSubmit(buttons[0]);
  expect(ui.prompt.value).toBe("");
});

test("changed character definitions reveal full regeneration and disable all image-only actions until restored", async () => {
  const { page } = await basePreview();
  const ui = bind(page);
  const full = ui.form.querySelector<HTMLButtonElement>('[value="generate"]')!;
  const name = ui.form.querySelector<HTMLInputElement>('[name="name"]')!;
  expect(full.hidden).toBe(true);
  name.value = "changed";
  name.dispatchEvent(new Event("input"));
  expect(full.hidden).toBe(false);
  expect(
    [...document.querySelectorAll<HTMLButtonElement>("[data-source-bound]")].every(
      (button) => button.disabled,
    ),
  ).toBe(true);
  name.value = character.name;
  name.dispatchEvent(new Event("input"));
  expect(full.hidden).toBe(true);
});
