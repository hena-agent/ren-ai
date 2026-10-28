import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useImageStyle } from "./use-image-style.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "startViewTransition");
});

test("style changes synchronously without decoding or starting a View Transition", () => {
  const decode = vi.spyOn(HTMLImageElement.prototype, "decode");
  const transition = vi.fn<() => void>();
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: transition,
  });
  const { result } = renderHook(() => useImageStyle("photo"));
  act(() => result.current.choose("anime"));
  expect(result.current.style).toBe("anime");
  expect(localStorage.getItem("ren-ai.discovery.image-style")).toBe("anime");
  act(() => result.current.choose("photo"));
  expect(result.current.style).toBe("photo");
  expect(localStorage.getItem("ren-ai.discovery.image-style")).toBe("photo");
  expect(decode).not.toHaveBeenCalled();
  expect(transition).not.toHaveBeenCalled();
});
