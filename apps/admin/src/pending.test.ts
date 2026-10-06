import { expect, test, vi } from "vitest";
import { bindPending } from "./pending.ts";
import { useBrowser } from "../test/browser.ts";

useBrowser();

test("every image intent prevents native navigation and invokes the queued submission transport, while saving stays native", () => {
  document.body.innerHTML =
    '<form data-generating="생성 중" data-regenerating="재시도 중"><button name="intent" value="generate">Image</button><output data-pending></output></form>';
  const form = document.querySelector("form")!;
  const button = form.querySelector("button")!;
  const submit = vi.fn<NonNullable<Parameters<typeof bindPending>[1]>>();
  bindPending(form, submit);
  for (const intent of ["generate", "portrait", "subportrait", "regenerate", "retry-image"]) {
    button.value = intent;
    const event = new SubmitEvent("submit", { cancelable: true, submitter: button });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(submit).toHaveBeenLastCalledWith(form, button);
    document.defaultView!.dispatchEvent(new Event("pageshow"));
  }
  expect(submit).toHaveBeenCalledTimes(5);
  button.value = "retry-image";
  form.dispatchEvent(new SubmitEvent("submit", { cancelable: true, submitter: button }));
  expect(form.querySelector("output")?.textContent).toBe("재시도 중");
  document.defaultView!.dispatchEvent(new Event("pageshow"));
  button.value = "save";
  const save = new SubmitEvent("submit", { cancelable: true, submitter: button });
  form.dispatchEvent(save);
  expect(save.defaultPrevented).toBe(false);
  expect(submit).toHaveBeenCalledTimes(6);
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

test("addition and single-image regeneration announce their progress and missing labels remain safe", () => {
  document.body.innerHTML =
    '<form data-regenerating="1장 다시 생성 중" data-adding="선택한 사진 생성 중"><button value="regenerate"></button><button value="subportrait"></button><output data-pending></output></form>';
  const form = document.querySelector("form")!;
  bindPending(form);
  for (const [intent, message] of [
    ["regenerate", "1장 다시 생성 중"],
    ["subportrait", "선택한 사진 생성 중"],
  ]) {
    form.dispatchEvent(
      new SubmitEvent("submit", {
        submitter: form.querySelector<HTMLButtonElement>(`[value="${intent}"]`)!,
      }),
    );
    expect(form.querySelector("output")?.textContent).toBe(message);
    document.defaultView!.dispatchEvent(new Event("pageshow"));
  }
  form.removeAttribute("data-regenerating");
  form.removeAttribute("data-adding");
  for (const button of form.querySelectorAll("button")) {
    form.dispatchEvent(new SubmitEvent("submit", { submitter: button }));
    expect(form.querySelector("output")?.textContent).toBe("");
    document.defaultView!.dispatchEvent(new Event("pageshow"));
  }
});
