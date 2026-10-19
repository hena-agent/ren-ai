import { afterEach, expect, test, vi } from "vitest";
import { decodeStyleImages, revealImageStyle } from "./style-transition.ts";

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "startViewTransition");
});

function nativeTransition(ready = Promise.resolve(), finished = Promise.resolve()) {
  const transition = { ready, finished, updateCallbackDone: Promise.resolve() };
  const start = vi.fn<(commit: () => void) => typeof transition>((commit) => {
    commit();
    return transition;
  });
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
  return start;
}

test("preparation decodes unique nonempty image URLs", async () => {
  const sources: string[] = [];
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    sources.push(this.src);
    return Promise.resolve();
  });
  await decodeStyleImages(["", "/a.webp", "/a.webp", "/b.webp"]);
  expect(sources).toEqual(
    ["a.webp", "b.webp"].map((file) => new URL(file, window.location.href).href),
  );
});

test.each(["unsupported", "skipped"] as const)(
  "%s transitions still commit the style and clean their scope",
  async (mode) => {
    if (mode === "skipped") nativeTransition(Promise.reject(new Error("capture unavailable")));
    const commit = vi.fn<() => void>();
    await revealImageStyle(commit);
    expect(commit).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains("style-reveal")).toBe(false);
  },
);

test("reduced motion commits immediately without capturing a transition", async () => {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  Object.defineProperty(query, "matches", { value: true });
  vi.spyOn(window, "matchMedia").mockReturnValue(query);
  const start = nativeTransition();
  const commit = vi.fn<() => void>();
  await revealImageStyle(commit);
  expect(commit).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
});

test("the native reveal keeps its root scope until animation completion and then cleans it", async () => {
  let finish: () => void = vi.fn<() => void>();
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const start = nativeTransition(Promise.resolve(), completed);
  const commit = vi.fn<() => void>();
  const pending = revealImageStyle(commit);
  expect(start).toHaveBeenCalledOnce();
  expect(commit).toHaveBeenCalledOnce();
  expect(document.documentElement.classList.contains("style-reveal")).toBe(true);
  expect(document.documentElement.style.getPropertyValue("--style-reveal-radius")).not.toBe("");
  finish();
  await pending;
  expect(document.documentElement.classList.contains("style-reveal")).toBe(false);
  expect(document.documentElement.style.getPropertyValue("--style-reveal-radius")).toBe("");
});

test("native transition failures clear the root reveal scope", async () => {
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: () => {
      throw new Error("snapshot failed");
    },
  });
  await expect(revealImageStyle(vi.fn<() => void>())).rejects.toThrow("snapshot failed");
  expect(document.documentElement.classList.contains("style-reveal")).toBe(false);
  expect(document.documentElement.style.getPropertyValue("--style-reveal-radius")).toBe("");
});
