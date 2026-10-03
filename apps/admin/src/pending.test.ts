import { Window } from "happy-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { bindPending } from "./pending.ts";

let browser: Window;
beforeEach(() => {
  browser = new Window();
  vi.stubGlobal("document", browser.document);
  vi.stubGlobal("SubmitEvent", browser.SubmitEvent);
  vi.stubGlobal("Event", browser.Event);
});
afterEach(async () => {
  await browser.happyDOM.close();
  vi.unstubAllGlobals();
});

test("generation announces progress, prevents repeated native submissions and recovers on browser navigation", () => {
  document.body.innerHTML =
    '<form data-generating="생성 중" data-saving="저장 중"><button value="generate">생성</button><button value="save">저장</button><output data-pending></output></form>';
  const form = document.querySelector("form")!;
  bindPending(form);
  const submit = new SubmitEvent("submit", {
    cancelable: true,
    submitter: form.querySelector("button")!,
  });
  expect(form.dispatchEvent(submit)).toBe(true);
  expect(submit.defaultPrevented).toBe(false);
  expect(form.getAttribute("aria-busy")).toBe("true");
  expect(form.querySelector("output")?.textContent).toBe("생성 중");
  expect(form.dispatchEvent(new SubmitEvent("submit", { cancelable: true }))).toBe(false);
  document.defaultView!.dispatchEvent(new Event("pageshow"));
  expect(form.hasAttribute("aria-busy")).toBe(false);
  expect(form.querySelector("output")?.textContent).toBe("");
  expect(
    form.dispatchEvent(
      new SubmitEvent("submit", {
        cancelable: true,
        submitter: form.querySelector<HTMLButtonElement>('[value="save"]')!,
      }),
    ),
  ).toBe(true);
  expect(form.querySelector("output")?.textContent).toBe("저장 중");
});

test("pending binding also handles submit without a button, absent copy and forms without a status output", () => {
  const errors: string[] = [];
  document.defaultView!.addEventListener("error", (event) => errors.push(event.message));
  document.body.innerHTML =
    '<form><button value="save"></button><output data-pending></output></form><form id="plain"></form>';
  const form = document.querySelector("form")!;
  bindPending(form);
  form.dispatchEvent(new SubmitEvent("submit"));
  expect(form.querySelector("output")?.textContent).toBe("");
  document.defaultView!.dispatchEvent(new Event("pageshow"));
  form.dispatchEvent(new SubmitEvent("submit", { submitter: form.querySelector("button")! }));
  expect(form.querySelector("output")?.textContent).toBe("");
  const plain = document.querySelector<HTMLFormElement>("#plain")!;
  bindPending(plain);
  plain.dispatchEvent(new SubmitEvent("submit"));
  expect(plain.getAttribute("aria-busy")).toBe("true");
  document.defaultView!.dispatchEvent(new Event("pageshow"));
  expect(plain.hasAttribute("aria-busy")).toBe(false);
  expect(errors).toEqual([]);
});
