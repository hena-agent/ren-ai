import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useImageStyle } from "./use-image-style.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "startViewTransition");
});

test("a pending preparation keeps the active style and blocks overlapping switches", async () => {
  let finish: () => void = vi.fn<() => void>();
  const decoded = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const decode = vi.spyOn(HTMLImageElement.prototype, "decode").mockReturnValue(decoded);
  const { result } = renderHook(useImageStyle);
  let pending = Promise.resolve();
  act(() => {
    pending = result.current.choose("photo", ["/photo.webp"]);
  });
  expect(result.current.style).toBe("anime");
  expect(result.current.changing).toBe(true);
  await act(async () => {
    await result.current.choose("anime", []);
  });
  expect(decode).toHaveBeenCalledOnce();
  await act(async () => {
    finish();
    await pending;
  });
  expect(result.current.style).toBe("photo");
  expect(result.current.changing).toBe(false);
  expect(localStorage.getItem("ren-ai.discovery.image-style")).toBe("photo");
});

test("transition-stage failures retain the style and expose payload-safe stage diagnostics", async () => {
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: () => {
      throw new Error("private-snapshot-data");
    },
  });
  const mark = vi.spyOn(performance, "mark");
  const { result } = renderHook(useImageStyle);
  await act(async () => {
    await result.current.choose("photo", []);
  });
  expect(result.current.style).toBe("anime");
  expect(result.current.issue).toBe("load");
  expect(result.current.changing).toBe(false);
  const diagnostics = mark.mock.calls.filter(([name]) => name === "discovery.imageStyle.failed");
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.[1]).toMatchObject({
    detail: { stage: "transition", causeName: "Error", outcome: "failed" },
  });
  expect(JSON.stringify(mark.mock.calls)).not.toContain("private-snapshot-data");
});
