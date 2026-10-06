import { expect, test, vi } from "vitest";
import { character, fixture, request, tokenOf } from "../test/fixtures.ts";
import { bindPending } from "./pending.ts";
import { bindPortraitDialog } from "./portrait-dialog.ts";
import copy from "./copy.json";
import { useBrowser, fillCharacterForm } from "../test/browser.ts";

useBrowser();

async function editor(preview = false) {
  const { admin } = await fixture();
  let page = await (await admin(request("/new"))).text();
  if (preview)
    page = await (
      await admin(request("/personas", { ...character, draft: tokenOf(page), intent: "generate" }))
    ).text();
  document.body.innerHTML = page;
  const form = fillCharacterForm(character);
  const dialog = form.querySelector<HTMLDialogElement>("dialog")!;
  const input = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
  const button = (selector: string) => form.querySelector<HTMLButtonElement>(selector)!;
  const submissions: { intent: string | null; prompt: string | null; busy: string | null }[] = [];
  const buttons = form.ownerDocument.querySelectorAll("button").length;
  const transports: {
    connected: boolean | undefined;
    hidden: HTMLElement["hidden"] | undefined;
    form: HTMLFormElement | null | undefined;
  }[] = [];
  bindPending(form);
  form.addEventListener("submit", (event) => {
    if (event.defaultPrevented) return;
    transports.push({
      connected: event.submitter?.isConnected,
      hidden: event.submitter?.hidden,
      form: event.submitter?.closest("form"),
    });
    const value = new FormData(form).get("portraitInstructions");
    submissions.push({
      intent: event.submitter?.getAttribute("value") ?? null,
      prompt: typeof value === "string" ? value : null,
      busy: form.getAttribute("aria-busy"),
    });
    event.preventDefault();
  });
  return { form, dialog, input, button, submissions, buttons, transports };
}

test("first generation opens a focused modal and only submits the optional prompt after confirmation", async () => {
  const { form, dialog, input, button, submissions, buttons, transports } = await editor();
  const generate = button('[value="generate"]');
  generate.focus();
  form.requestSubmit(generate);
  expect(dialog.open).toBe(true);
  expect(document.activeElement).toBe(input);
  expect(form.hasAttribute("aria-busy")).toBe(false);
  expect(form.querySelector("[data-pending]")?.textContent).toBe("");
  expect(submissions).toEqual([]);
  input.value = "햇살 아래 웃는 모습";
  button("[data-portrait-confirm]").click();
  expect(dialog.open).toBe(false);
  expect(document.querySelectorAll("button")).toHaveLength(buttons);
  expect(transports).toEqual([{ connected: true, hidden: true, form }]);
  expect(document.activeElement).toBe(generate);
  expect(submissions).toEqual([
    { intent: "generate", prompt: "햇살 아래 웃는 모습", busy: "true" },
  ]);
  expect(form.querySelector("[data-pending]")?.textContent).toBe(copy.generating);
  form.requestSubmit(generate);
  expect(dialog.open).toBe(false);
  expect(submissions).toHaveLength(1);
});

test("cancelling the modal makes no request and a blank prompt can be confirmed on reopening", async () => {
  const { form, dialog, input, button, submissions } = await editor();
  const generate = button('[value="generate"]');
  form.requestSubmit(generate);
  button("[data-portrait-cancel]").click();
  expect(dialog.open).toBe(false);
  expect(form.hasAttribute("aria-busy")).toBe(false);
  expect(submissions).toEqual([]);
  expect(document.activeElement).toBe(generate);
  form.requestSubmit(generate);
  expect(dialog.open).toBe(true);
  expect(input.value).toBe("");
  button("[data-portrait-confirm]").click();
  expect(submissions).toEqual([{ intent: "generate", prompt: "", busy: "true" }]);
  document.defaultView!.dispatchEvent(new Event("pageshow"));
  form.requestSubmit(generate);
  expect(dialog.open).toBe(true);
});

test("one generating action changes its label after a preview and saving bypasses the modal", async () => {
  const { form, dialog, button, submissions } = await editor(true);
  const generate = button('[value="generate"]');
  expect(generate.textContent).toBe(copy.regenerate);
  expect(form.querySelectorAll('[value="generate"]')).toHaveLength(1);
  form.requestSubmit(generate);
  expect(dialog.open).toBe(true);
  button("[data-portrait-confirm]").click();
  expect(submissions).toEqual([{ intent: "generate", prompt: "", busy: "true" }]);
  document.defaultView!.dispatchEvent(new Event("pageshow"));
  generate.value = "portrait";
  form.requestSubmit(generate);
  expect(dialog.open).toBe(true);
  expect(submissions).toHaveLength(1);
  button("[data-portrait-confirm]").click();
  expect(submissions.at(-1)?.intent).toBe("portrait");
  document.defaultView!.dispatchEvent(new Event("pageshow"));
  form.requestSubmit(button('[value="save"]'));
  expect(dialog.open).toBe(false);
  expect(submissions.at(-1)).toEqual({ intent: "save", prompt: "", busy: "true" });
  expect(form.querySelector("[data-pending]")?.textContent).toBe(copy.saving);
});

test("dialog binding respects prevented events and submissions without a generating button", async () => {
  document.body.innerHTML =
    '<form><dialog data-portrait-dialog><textarea></textarea><button type="button" data-portrait-cancel>Cancel</button><button type="button" data-portrait-confirm>Confirm</button></dialog><button value="save">Save</button><button value="generate">Generate</button></form>';
  const form = document.querySelector("form")!;
  const dialog = form.querySelector("dialog")!;
  const errors: string[] = [];
  document.defaultView!.addEventListener("error", (event) => errors.push(event.message));
  bindPortraitDialog(form);
  const prevented = new SubmitEvent("submit", {
    cancelable: true,
    submitter: form.querySelector('button[value="generate"]')!,
  });
  prevented.preventDefault();
  expect(form.dispatchEvent(prevented)).toBe(false);
  expect(dialog.open).toBe(false);
  expect(
    form.dispatchEvent(
      new SubmitEvent("submit", {
        cancelable: true,
        submitter: form.querySelector('button[value="save"]')!,
      }),
    ),
  ).toBe(true);
  expect(dialog.open).toBe(false);
  dialog.dispatchEvent(new Event("close"));
  expect(form.dispatchEvent(new SubmitEvent("submit", { cancelable: true }))).toBe(true);
  expect(dialog.open).toBe(false);
  expect(errors).toEqual([]);
});

test("confirmation restores its guard even if native submission throws", async () => {
  const { form, dialog, button } = await editor();
  const errors: string[] = [];
  document.defaultView!.addEventListener("error", (event) => errors.push(event.message));
  form.requestSubmit(button('[value="generate"]'));
  const submit = vi.spyOn(form, "requestSubmit").mockImplementation(() => {
    throw new Error("submit failed");
  });
  button("[data-portrait-confirm]").click();
  expect(errors).toEqual(["submit failed"]);
  expect(dialog.open).toBe(false);
  submit.mockRestore();
  form.requestSubmit(button('[value="generate"]'));
  expect(dialog.open).toBe(true);
});

test("image-options context remains empty for a legacy button without a target label", async () => {
  const { form, dialog, button } = await editor();
  const generate = button('[value="generate"]');
  generate.removeAttribute("data-portrait-label");
  form.requestSubmit(generate);
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector("[data-portrait-target]")?.textContent).toBe("");
});
