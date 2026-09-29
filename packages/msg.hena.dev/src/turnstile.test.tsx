import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Turnstile } from "./turnstile.tsx";
import { widget, widgetOptions } from "./turnstile.fake.ts";

const onToken = vi.fn<(token: string | null) => void>();

beforeEach(() => {
  vi.clearAllMocks();
  window.turnstile = widget;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.turnstile;
});

function mountBeforeScript() {
  delete window.turnstile;
  const append = vi.spyOn(document.head, "append").mockImplementation(() => {});
  const view = render(<Turnstile onToken={onToken} />);
  const script = append.mock.calls[0]?.[0];
  if (!(script instanceof HTMLScriptElement)) throw new Error("Missing Turnstile script");
  const removeScript = vi.spyOn(script, "remove");
  return { view, script, removeScript };
}

it("loads Turnstile when its script arrives after mounting", () => {
  const { view, script, removeScript } = mountBeforeScript();
  expect(script.src).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
  expect(script.async).toBe(true);
  window.turnstile = widget;
  fireEvent.load(script);
  expect(widget.render).toHaveBeenCalledWith(view.container.firstChild, widgetOptions);
  view.unmount();
  expect(widget.remove).toHaveBeenCalledWith("widget-id");
  expect(removeScript).toHaveBeenCalledTimes(1);
});

it("removes script listeners even when loading never supplies Turnstile", () => {
  const { view, script, removeScript } = mountBeforeScript();
  const removeListener = vi.spyOn(script, "removeEventListener");
  fireEvent.load(script);
  expect(widget.render).not.toHaveBeenCalled();
  view.unmount();
  expect(widget.remove).not.toHaveBeenCalled();
  expect(removeListener).toHaveBeenCalledWith("load", expect.any(Function));
  expect(removeListener).toHaveBeenCalledWith("error", expect.any(Function));
  expect(removeScript).toHaveBeenCalledTimes(1);
  fireEvent.error(script);
  expect(onToken).not.toHaveBeenCalled();
  window.turnstile = widget;
  fireEvent.load(script);
  expect(widget.render).not.toHaveBeenCalled();
});

it.each([
  [false, "empty ID"],
  [true, "empty ID"],
  [false, "missing API"],
  [true, "missing API"],
] as const)("cleans up safely (late script: %s, %s)", (late, missing) => {
  if (missing === "empty ID") widget.render.mockReturnValueOnce("");
  const { view, script } = late
    ? mountBeforeScript()
    : { view: render(<Turnstile onToken={onToken} />), script: null };
  if (script) {
    window.turnstile = widget;
    fireEvent.load(script);
  }
  if (missing === "missing API") delete window.turnstile;
  view.unmount();
  expect(widget.remove).not.toHaveBeenCalled();
});

it("rebinds callbacks when the token handler changes", () => {
  const second = vi.fn<(token: string | null) => void>();
  const view = render(<Turnstile onToken={onToken} />);
  const previous = widgetOptions.callback;
  view.rerender(<Turnstile onToken={second} />);
  act(() => widgetOptions.callback("updated"));
  expect(widget.render).toHaveBeenCalledTimes(2);
  expect(widget.remove).toHaveBeenCalledWith("widget-id");
  expect(second).toHaveBeenCalledWith("updated");
  expect(previous).not.toBe(widgetOptions.callback);
});

it("reports failure when the script cannot load", () => {
  const { script } = mountBeforeScript();
  fireEvent.error(script);
  expect(onToken).toHaveBeenCalledExactlyOnceWith(null);
});
