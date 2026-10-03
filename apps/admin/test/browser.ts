import { Window } from "happy-dom";
import { afterEach, beforeEach, vi } from "vitest";

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
