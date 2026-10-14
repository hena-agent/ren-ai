import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Turnstile } from "@ren-ai/onboarding/turnstile";

type Widget = NonNullable<Window["turnstile"]>;
let options: Parameters<Widget["render"]>[1];
const widget = {
  render: vi.fn<Widget["render"]>((_element, rendered) => {
    options = rendered;
    return "widget-id";
  }),
  remove: vi.fn<Widget["remove"]>(),
};
const onToken = vi.fn<(token: string | null) => void>();
const mount = (handler = onToken) => <Turnstile onToken={handler} siteKey="site-key" />;

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
  const view = render(mount());
  const script = append.mock.calls[0]?.[0];
  if (!(script instanceof HTMLScriptElement)) throw new Error("Missing Turnstile script");
  const removeScript = vi.spyOn(script, "remove");
  return { view, script, removeScript };
}

it("passes tokens, expiry and failures to its handler", () => {
  render(mount());
  expect(options.sitekey).toBe("site-key");
  act(() => options.callback("passed"));
  act(() => options["expired-callback"]());
  act(() => options["error-callback"]());
  act(() => options["unsupported-callback"]());
  expect(onToken.mock.calls).toEqual([["passed"], [""], [null], [null]]);
});

it("loads Turnstile when its script arrives after mounting", () => {
  const { view, script, removeScript } = mountBeforeScript();
  expect(script.src).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
  expect(script.async).toBe(true);
  window.turnstile = widget;
  fireEvent.load(script);
  expect(widget.render).toHaveBeenCalledWith(view.container.firstChild, options);
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
  const { view, script } = late ? mountBeforeScript() : { view: render(mount()), script: null };
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
  const view = render(mount());
  const previous = options.callback;
  view.rerender(mount(second));
  act(() => options.callback("updated"));
  expect(widget.render).toHaveBeenCalledTimes(2);
  expect(widget.remove).toHaveBeenCalledWith("widget-id");
  expect(second).toHaveBeenCalledWith("updated");
  expect(previous).not.toBe(options.callback);
});

it("reports failure when the script cannot load", () => {
  const { script } = mountBeforeScript();
  fireEvent.error(script);
  expect(onToken).toHaveBeenCalledExactlyOnceWith(null);
});
