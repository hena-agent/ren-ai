import { expect, test } from "vitest";
import { useBrowser, fillCharacterForm } from "../test/browser.ts";
import { character, fixture, request } from "../test/fixtures.ts";
import { basePreview } from "../test/sub-portraits.ts";
import { bindPending } from "./pending.ts";

useBrowser();

test("two added photos have two independent prompts; count changes preserve each draft and a new style clears them", async () => {
  const { page } = await basePreview();
  document.body.innerHTML = page;
  const form = document.querySelector<HTMLFormElement>("#persona-editor")!;
  bindPending(form);
  const dialog = form.querySelector<HTMLDialogElement>("dialog")!;
  const count = dialog.querySelector<HTMLSelectElement>("select")!;
  const errors: string[] = [];
  document.defaultView!.addEventListener("error", (event) => errors.push(event.message));
  const add = form.querySelectorAll<HTMLButtonElement>('[value="subportrait"]');
  form.requestSubmit(add[1]);
  expect(dialog.querySelectorAll("textarea:not(:disabled)")).toHaveLength(1);
  count.value = "2";
  count.dispatchEvent(new Event("change"));
  const prompts = dialog.querySelectorAll("textarea");
  expect(dialog.querySelectorAll("textarea:not(:disabled)")).toHaveLength(2);
  for (const field of dialog.querySelectorAll("[data-image-prompt-field]")) {
    const label = field.querySelector("label")!;
    const input = field.querySelector("textarea")!;
    expect(label.htmlFor).toBe(input.id);
    expect(input.id).not.toBe("");
    expect(field.hasAttribute("hidden")).toBe(false);
  }
  expect(dialog.querySelectorAll("label")[1]?.textContent).toContain("실사 사진 1");
  expect(dialog.querySelectorAll("label")[2]?.textContent).toContain("실사 사진 2");
  prompts[0]!.value = "phone selfie";
  prompts[1]!.value = "friend-taken full-body travel";
  expect(new FormData(form).get("portraitInstructions")).toBe("phone selfie");
  expect(new FormData(form).getAll("imagePrompts")).toEqual(["friend-taken full-body travel"]);
  count.value = "1";
  count.dispatchEvent(new Event("change"));
  expect(dialog.querySelectorAll("[data-image-prompt-field]")[1]?.hasAttribute("hidden")).toBe(
    true,
  );
  expect(new FormData(form).getAll("imagePrompts")).toEqual([]);
  count.value = "2";
  count.dispatchEvent(new Event("change"));
  expect(dialog.querySelectorAll("textarea")[1]?.value).toBe("friend-taken full-body travel");
  dialog.querySelector<HTMLButtonElement>("[data-portrait-cancel]")!.click();
  form.requestSubmit(add[0]);
  expect(count.value).toBe("1");
  expect([...dialog.querySelectorAll("textarea")].every((input) => !input.value)).toBe(true);
  expect(dialog.querySelector("[data-image-prompt-field] label")?.textContent).toContain(
    "애니메 사진 1",
  );
  expect(errors).toEqual([]);
});

test("initial count is per style, but prompts are per actual photo and ordered to match the single worker", async () => {
  const { admin } = await fixture();
  document.body.innerHTML = await (await admin(request("/new"))).text();
  const form = fillCharacterForm(character);
  bindPending(form);
  form.requestSubmit(form.querySelector<HTMLButtonElement>('[value="generate"]'));
  const dialog = form.querySelector<HTMLDialogElement>("dialog")!;
  const count = dialog.querySelector<HTMLSelectElement>("select")!;
  expect(dialog.querySelectorAll("textarea")).toHaveLength(2);
  count.value = "2";
  count.dispatchEvent(new Event("change"));
  expect(dialog.querySelectorAll("textarea:not(:disabled)")).toHaveLength(4);
  expect(
    [...dialog.querySelectorAll("[data-image-prompt-field] label")].map(
      (label) => label.textContent,
    ),
  ).toEqual([
    "애니메 사진 1 · 추가 프롬프트 (선택)",
    "실사 사진 1 · 추가 프롬프트 (선택)",
    "애니메 사진 2 · 추가 프롬프트 (선택)",
    "실사 사진 2 · 추가 프롬프트 (선택)",
  ]);
  expect(dialog.querySelector("[data-image-total]")?.textContent).toBe(
    "애니메·실사 각각 2장 · 총 4장 생성",
  );
  expect(new FormData(form).get("separateImagePrompts")).toBe("1");
  expect(new FormData(form).getAll("imagePrompts")).toEqual(["", "", ""]);
});

test("single-image regeneration always has one prompt labeled for the selected existing image", async () => {
  const { page } = await basePreview();
  document.body.innerHTML = page;
  const form = document.querySelector<HTMLFormElement>("#persona-editor")!;
  bindPending(form);
  form.requestSubmit(document.querySelectorAll<HTMLButtonElement>('[value="regenerate"]')[1]);
  const dialog = form.querySelector<HTMLDialogElement>("dialog")!;
  expect(dialog.querySelectorAll("textarea:not(:disabled)")).toHaveLength(1);
  expect(dialog.querySelector("[data-image-prompt-field] label")?.textContent).toContain(
    "실사 사진 1",
  );
  expect(dialog.querySelector<HTMLSelectElement>("select")?.options[1]?.disabled).toBe(true);
});

test("failed row retry restores only that photo's prompt and index, and always caps count at one", async () => {
  const { page } = await basePreview();
  document.body.innerHTML = page;
  const form = document.querySelector<HTMLFormElement>("#persona-editor")!;
  const retry = document.createElement("button");
  retry.type = "submit";
  retry.value = "retry-image";
  retry.dataset["portraitOperation"] = "retry:job:4";
  retry.dataset["portraitPrompt"] = "keep this failed photo";
  retry.dataset["portraitStyle"] = "anime";
  retry.dataset["imageIndex"] = "4";
  form.append(retry);
  bindPending(form);
  form.requestSubmit(retry);
  const dialog = form.querySelector<HTMLDialogElement>("dialog")!;
  expect(dialog.querySelector<HTMLSelectElement>("select")?.value).toBe("1");
  expect(dialog.querySelector<HTMLSelectElement>("select")?.options[1]?.disabled).toBe(true);
  expect(dialog.querySelector("textarea")?.value).toBe("keep this failed photo");
  expect(dialog.querySelector("[data-image-prompt-field] label")?.textContent).toContain(
    "애니메 사진 5",
  );
  expect(dialog.querySelectorAll("textarea:not(:disabled)")).toHaveLength(1);
});
