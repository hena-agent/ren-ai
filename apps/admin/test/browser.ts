import { Window } from "happy-dom";
import { afterEach, beforeEach, vi } from "vitest";

export function fillCharacterForm(character: { name: string; description: string }) {
  const form = document.querySelector<HTMLFormElement>("#persona-editor")!;
  form.querySelector<HTMLInputElement>('[name="name"]')!.value = character.name;
  form.querySelector<HTMLTextAreaElement>('[name="description"]')!.value = character.description;
  return form;
}

export function useBrowser() {
  let browser: Window;
  beforeEach(() => {
    browser = new Window();
    vi.stubGlobal("document", browser.document);
    vi.stubGlobal("SubmitEvent", browser.SubmitEvent);
    vi.stubGlobal("Event", browser.Event);
    vi.stubGlobal("FormData", browser.FormData);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await browser.happyDOM.close();
  });
}
