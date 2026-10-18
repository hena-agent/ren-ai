import { afterEach, expect, test, vi } from "vitest";
import { useBrowser } from "../test/browser.ts";
import { watchImageQueue } from "./image-queue-browser.ts";

useBrowser();
afterEach(() => vi.useRealTimers());

test("progress pauses hidden tabs and stops with a completed open dialog", async () => {
  vi.useFakeTimers();
  document.body.innerHTML =
    '<section data-image-job="batch" data-job-active="true"><div data-image-progress><output data-queue-status></output></div></section><dialog data-portrait-dialog open></dialog><input name="draft" value="old">';
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        document.body.innerHTML.replace('data-job-active="true"', 'data-job-active="false"'),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  watchImageQueue();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(999);
  expect(fetcher).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(document.querySelector<HTMLDialogElement>("dialog")!.open).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledOnce();
});
