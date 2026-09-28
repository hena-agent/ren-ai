import { afterEach, expect, it, vi } from "vitest";
import { locationFromPath, showLocation } from "./location.ts";

afterEach(() => vi.unstubAllGlobals());

it("reads a deep link and falls back for unknown people or sessions", () => {
  expect(locationFromPath("/personas/jiwoo/sessions/6713a5b2-0000")).toEqual({
    persona: "jiwoo",
    sessionId: "6713a5b2-0000",
  });
  expect(locationFromPath("/")).toEqual({ persona: "harin", sessionId: null });
  expect(locationFromPath("/personas/ghost/sessions/old")).toEqual({
    persona: "harin",
    sessionId: null,
  });
  expect(locationFromPath("/personas/harin/sessions/bad%2Fid")).toEqual({
    persona: "harin",
    sessionId: null,
  });
});

it("records selections in history and avoids repeating the current path", () => {
  let pathname = "/";
  const pushState = vi.fn<(_state: null, _title: string, path: string) => void>(
    (_state, _title, path) => {
      pathname = path;
    },
  );
  const replaceState = vi.fn<(_state: null, _title: string, path: string) => void>(
    (_state, _title, path) => {
      pathname = path;
    },
  );
  vi.stubGlobal("window", {
    location: {
      get pathname() {
        return pathname;
      },
    },
    history: { pushState, replaceState },
  });
  showLocation("jiwoo", "first", "replace");
  expect(replaceState).toHaveBeenCalledWith(null, "", "/personas/jiwoo/sessions/first");
  showLocation("jiwoo", "first", "push");
  expect(pushState).not.toHaveBeenCalled();
  showLocation("jiwoo", "second", "push");
  expect(pushState).toHaveBeenCalledWith(null, "", "/personas/jiwoo/sessions/second");
  showLocation("jiwoo", "a b", "push");
  expect(pushState).toHaveBeenCalledWith(null, "", "/personas/jiwoo/sessions/a%20b");
});
