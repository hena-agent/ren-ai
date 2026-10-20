import { expect, test } from "vitest";
import { character, fixture, generator, request, tokenOf } from "../test/fixtures.ts";
import { useBrowser, fillCharacterForm } from "../test/browser.ts";
import { bindPending } from "./pending.ts";

useBrowser();

test("new sheet creation confirms exactly two optional prompts and changing to one style resets only that action", async () => {
  const { admin } = await fixture();
  document.body.innerHTML = await (await admin(request("/new"))).text();
  const form = fillCharacterForm(character);
  const dialog = form.querySelector<HTMLDialogElement>("[data-portrait-dialog]")!;
  const bulk = form.querySelector<HTMLButtonElement>('[value="sheets"]')!;
  const count = form.querySelector<HTMLSelectElement>('[name="imageCount"]')!;
  const cancel = dialog.querySelector<HTMLButtonElement>("[data-portrait-cancel]")!;
  const calls: (HTMLElement | null)[] = [];
  bindPending(form, (_form, button) => {
    calls.push(button);
  });
  form.requestSubmit(bulk);
  expect(dialog.open).toBe(true);
  expect(count.value).toBe("1");
  expect([...count.options].slice(1).every((option) => option.disabled)).toBe(true);
  expect(dialog.querySelector("[data-image-total]")?.textContent).toBe(
    "애니메·실사 인물 시트 각 1장 · 총 2장 생성",
  );
  expect(
    [...dialog.querySelectorAll("[data-image-prompt-field] label")].map(
      (label) => label.textContent,
    ),
  ).toEqual(["애니메 인물 시트 · 추가 프롬프트 (선택)", "실사 인물 시트 · 추가 프롬프트 (선택)"]);
  dialog.querySelector("textarea")!.value = "a subtle distinguishing feature";
  cancel.click();
  expect(calls).toEqual([]);
  form.requestSubmit(bulk);
  expect(dialog.querySelector("textarea")!.value).toBe("a subtle distinguishing feature");
  cancel.click();
  const single = form.querySelector<HTMLButtonElement>(
    '[value="sheet"][data-portrait-style="photo"]',
  )!;
  form.requestSubmit(single);
  expect(dialog.querySelector("[data-image-total]")?.textContent).toBe(
    "선택한 스타일의 인물 시트 1장 생성",
  );
  expect(dialog.querySelector("textarea")!.value).toBe("");
  expect(dialog.querySelectorAll("textarea:not(:disabled)")).toHaveLength(1);
  dialog.querySelector<HTMLButtonElement>("[data-portrait-confirm]")!.click();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.getAttribute("value")).toBe("sheet");
});

test("a failed same-target sheet preserves its optional prompt on reopening", async () => {
  const { admin } = await fixture({
    ...generator,
    sheet: async () => {
      throw new Error("provider unavailable");
    },
  });
  const empty = await (await admin(request("/new"))).text();
  const failed = await admin(
    request("/personas?style=anime", {
      ...character,
      draft: tokenOf(empty),
      intent: "sheet",
      portraitInstructions: "keep this identity direction",
    }),
  );
  expect(failed.status).toBe(503);
  document.body.innerHTML = await failed.text();
  const form = fillCharacterForm(character);
  bindPending(form);
  form.requestSubmit(
    form.querySelector<HTMLButtonElement>('[value="sheet"][data-portrait-style="anime"]'),
  );
  expect(form.querySelector<HTMLTextAreaElement>('[name="portraitInstructions"]')!.value).toBe(
    "keep this identity direction",
  );
});
