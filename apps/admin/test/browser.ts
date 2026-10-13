import { Window } from "happy-dom";
import { afterEach, beforeEach, vi } from "vitest";

export function fillCharacterForm(character: { name: string; description: string }) {
  const form = document.querySelector<HTMLFormElement>("#persona-editor")!;
  form.querySelector<HTMLInputElement>('[name="name"]')!.value = character.name;
  form.querySelector<HTMLTextAreaElement>('[name="description"]')!.value = character.description;
  return form;
}

export function useBrowser(cleanup?: () => void) {
  let browser: Window;
  beforeEach(() => {
    browser = new Window();
    vi.stubGlobal("document", browser.document);
    vi.stubGlobal("window", browser);
    vi.stubGlobal("MutationObserver", browser.MutationObserver);
    vi.stubGlobal("ResizeObserver", browser.ResizeObserver);
    vi.stubGlobal("getComputedStyle", browser.getComputedStyle.bind(browser));
    vi.stubGlobal("requestAnimationFrame", browser.requestAnimationFrame.bind(browser));
    vi.stubGlobal("cancelAnimationFrame", browser.cancelAnimationFrame.bind(browser));
    vi.stubGlobal("SubmitEvent", browser.SubmitEvent);
    vi.stubGlobal("Event", browser.Event);
    vi.stubGlobal("FormData", browser.FormData);
  });
  afterEach(async () => {
    cleanup?.();
    await browser.happyDOM.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}
