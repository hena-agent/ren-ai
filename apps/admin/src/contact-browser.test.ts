import { expect, test, vi } from "vitest";
import { useBrowser } from "../test/browser.ts";
import { bindContactManagement } from "./contact-browser.ts";

useBrowser();
const markup = (count = 2) => `<form id="contact-direct-selection" data-contact-retry="false">
  <output data-contact-count></output>
  <button data-contact-needs-selection value="select-specific"></button>
  <button data-contact-needs-selection value="hide"></button>
</form><input type="checkbox" data-contact-all>
${Array.from({ length: count }, (_, i) => `<input type="checkbox" data-contact-select data-eligible="${i !== 1}">`).join("")}`;
const rows = () => [...document.querySelectorAll<HTMLInputElement>("[data-contact-select]")];
const change = (input: HTMLInputElement, checked: boolean) => {
  input.checked = checked;
  input.dispatchEvent(new Event("change"));
};

test("bulk controls select at most 100 visible rows and prevent ineligible direct selection without blocking hiding", () => {
  document.body.innerHTML = markup();
  bindContactManagement(document);
  const select = document.querySelector<HTMLButtonElement>('[value="select-specific"]')!;
  const hide = document.querySelector<HTMLButtonElement>('[value="hide"]')!;
  const all = document.querySelector<HTMLInputElement>("[data-contact-all]")!;
  expect(select.disabled).toBe(true);
  expect(hide.disabled).toBe(true);
  change(rows()[0]!, true);
  expect(select.disabled).toBe(false);
  expect(hide.disabled).toBe(false);
  expect(all.indeterminate).toBe(true);
  change(all, true);
  expect(select.disabled).toBe(true);
  expect(hide.disabled).toBe(false);
  expect(document.querySelector("output")!.textContent).toBe("2명 선택");
  change(all, false);
  expect(rows().every((row) => !row.checked)).toBe(true);
  document.body.innerHTML = markup(101);
  bindContactManagement(document);
  change(document.querySelector<HTMLInputElement>("[data-contact-all]")!, true);
  expect(rows().filter((row) => row.checked)).toHaveLength(100);
  change(rows()[100]!, true);
  expect(document.querySelector("output")!.textContent).toContain("한 번에 최대 100명");
  expect(document.querySelector<HTMLButtonElement>('[value="hide"]')!.disabled).toBe(true);
});

test("empty pages and exact-selection retries keep their server state", () => {
  document.body.innerHTML = "";
  bindContactManagement(document);
  document.body.innerHTML = markup().replace(
    'data-contact-retry="false"',
    'data-contact-retry="true"',
  );
  bindContactManagement(document);
  expect(document.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
  document.body.innerHTML = markup().replace('<input type="checkbox" data-contact-all>', "");
  bindContactManagement(document);
});

test("invitation link and code copy acknowledge success and explain clipboard failures", async () => {
  document.body.innerHTML =
    '<button data-copy-text="private-code">복사</button><output data-copy-status></output>';
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  bindContactManagement(document);
  document.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() =>
    expect(document.querySelector("output")!.textContent).toBe("복사했습니다."),
  );
  expect(writeText).toHaveBeenCalledWith("private-code");
  writeText.mockRejectedValueOnce(new Error("denied"));
  document.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() =>
    expect(document.querySelector("output")!.textContent).toContain("직접 선택해 복사"),
  );
});
