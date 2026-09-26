import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copy } from "./copy.ts";
import { turnstileSiteKey } from "./config.ts";
import { onboardingClient } from "./onboarding-client.ts";
import type { OnboardingClient } from "./onboarding-client.ts";
import { Home } from "./pages/home.tsx";
import { Privacy } from "./pages/privacy.tsx";
import { getRouter } from "./router.tsx";
import { Turnstile } from "./turnstile.tsx";

const submit = vi.fn<OnboardingClient["submit"]>();
const joinWaitlist = vi.fn<OnboardingClient["joinWaitlist"]>();
const fake: OnboardingClient = { submit, joinWaitlist };
type Widget = NonNullable<Window["turnstile"]>;
let widgetOptions: Parameters<Widget["render"]>[1];
const remove = vi.fn<Widget["remove"]>();

function scriptFrom(node: string | Node | undefined): HTMLScriptElement {
  if (!(node instanceof HTMLScriptElement)) throw new Error("Missing Turnstile script");
  return node;
}

beforeEach(() => {
  copy.privacyNoticeVersion = "v1";
  submit.mockReset();
  joinWaitlist.mockReset();
  remove.mockReset();
  window.turnstile = {
    render: vi.fn<Widget["render"]>((_element, options) => {
      widgetOptions = options;
      return "widget-id";
    }),
    remove,
  };
});

afterEach(() => {
  copy.privacyNoticeVersion = "pending";
  cleanup();
  delete window.turnstile;
  vi.unstubAllGlobals();
});

it("offers no onboarding form and sends nothing while the privacy notice is pending", () => {
  copy.privacyNoticeVersion = "pending";
  render(<Home onboarding={fake} />);
  expect(screen.getByText(copy.privacy.placeholder)).toBeTruthy();
  expect(screen.queryByRole("button", { name: copy.form.submit })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: copy.form.consent })).toBeNull();
  expect(submit).not.toHaveBeenCalled();
});

it("refuses submission if the privacy notice becomes pending after the form renders", () => {
  render(<Home onboarding={fake} />);
  fillForm();
  const form = screen.getByRole("button", { name: copy.form.submit }).closest("form")!;
  copy.privacyNoticeVersion = "pending";
  fireEvent.submit(form);
  expect(submit).not.toHaveBeenCalled();
});

function fillForm(input = "010-1234-5678") {
  fireEvent.change(screen.getByRole("textbox", { name: copy.form.handleLabel }), {
    target: { value: input },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: copy.form.consent }));
  act(() => widgetOptions.callback("passed"));
}

function sendForm() {
  fillForm();
  fireEvent.click(screen.getByRole("button", { name: copy.form.submit }));
}

function expectPost(path: string, request: object) {
  expect(fetch).toHaveBeenCalledWith(
    `https://api-msg.hena.dev/${path}`,
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(request),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function mountBeforeScript() {
  const append = vi.spyOn(document.head, "append").mockImplementation(() => {});
  delete window.turnstile;
  const view = render(<Home onboarding={fake} />);
  const script = scriptFrom(append.mock.calls[0]?.[0]);
  return { append, view, script };
}

it("renders the root document in Korean", async () => {
  const router = getRouter(fake);
  expect(router.options.context.onboarding).toBe(fake);
  router.update({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { onboarding: fake },
  });
  await router.load();
  const html = renderToString(<RouterProvider router={router} />);
  expect(html).toContain('<html lang="ko">');
  expect(html).toContain('<meta charSet="utf-8"/>');
});

it("renders the form and privacy entries on their own", () => {
  const view = render(<Home onboarding={fake} />);
  expect(screen.getByRole("heading", { name: copy.home.title })).toBeTruthy();
  expect(screen.getByText(copy.home.description)).toBeTruthy();
  expect(screen.getByRole("combobox", { name: copy.form.countryLabel })).toHaveProperty(
    "value",
    copy.market.country,
  );
  expect(
    screen.getByRole("option", { name: `${copy.market.country} (${copy.market.dialCode})` }),
  ).toBeTruthy();
  expect(screen.getByRole("link", { name: copy.home.privacyLink })).toHaveProperty(
    "pathname",
    "/privacy",
  );
  expect(window.turnstile?.render).toHaveBeenCalled();
  expect(widgetOptions.sitekey).toBe(turnstileSiteKey);
  expect(turnstileSiteKey).toBe("1x00000000000000000000AA");
  expect(screen.getByRole("textbox", { name: copy.form.handleLabel })).toHaveProperty("value", "");
  expect(screen.queryByRole("alert")).toBeNull();
  view.unmount();
  expect(remove).toHaveBeenCalledWith("widget-id");
  render(<Privacy />);
  expect(screen.getByRole("heading", { name: copy.privacy.title })).toBeTruthy();
  expect(screen.getByText(copy.privacy.placeholder)).toBeTruthy();
  expect(screen.getByRole("link", { name: copy.privacy.homeLink })).toHaveProperty("pathname", "/");
});

it("does not submit without a valid Handle, consent and a live token", () => {
  render(<Home onboarding={fake} />);
  const button = screen.getByRole("button", { name: copy.form.submit });
  expect(button).toHaveProperty("disabled", true);
  expect(screen.getByRole("textbox", { name: copy.form.handleLabel })).toHaveProperty("value", "");
  fireEvent.change(screen.getByRole("textbox", { name: copy.form.handleLabel }), {
    target: { value: "invalid" },
  });
  expect(screen.getByRole("alert").textContent).toBe(copy.form.invalidHandle);
  expect(
    screen.getByRole("textbox", { name: copy.form.handleLabel }).getAttribute("aria-describedby"),
  ).toBe("handle-error");
  const event = new Event("submit", { bubbles: true, cancelable: true });
  fireEvent(button.closest("form")!, event);
  expect(event.defaultPrevented).toBe(true);
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: copy.form.handleLabel }), {
    target: { value: "01012345678" },
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByRole("textbox", { name: copy.form.handleLabel }).getAttribute("aria-describedby"),
  ).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: copy.form.consent }));
  expect(button).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("checkbox", { name: copy.form.consent }));
  act(() => widgetOptions.callback("passed"));
  expect(button).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("checkbox", { name: copy.form.consent }));
  act(() => widgetOptions["expired-callback"]());
  expect(button).toHaveProperty("disabled", true);
  act(() => widgetOptions.callback("passed"));
  act(() => widgetOptions["error-callback"]());
  expect(button).toHaveProperty("disabled", true);
  expect(submit).not.toHaveBeenCalled();
});

it.each([
  ["sent", false],
  ["no_imessage", true],
  ["unknown", true],
  ["full", true],
  ["try_later", false],
] as const)("shows %s and its Waitlist offer", async (answer, offer) => {
  submit.mockResolvedValue(answer);
  render(<Home onboarding={fake} />);
  fillForm();
  fireEvent.click(screen.getByRole("button", { name: copy.form.submit }));
  expect(await screen.findByText(copy.answers[answer])).toBeTruthy();
  expect(screen.queryByText(copy.form.waitlistLink) !== null).toBe(offer);
  expect(screen.queryByRole("textbox", { name: copy.waitlist.emailLabel }) !== null).toBe(offer);
  expect(submit).toHaveBeenCalledWith({
    handle: "+821012345678",
    locale: "ko",
    privacyNoticeVersion: copy.privacyNoticeVersion,
    turnstileToken: "passed",
  });
  expect(screen.getByRole("button", { name: copy.form.submit })).toHaveProperty("disabled", true);
});

it.each(["no_imessage", "unknown", "full"] as const)(
  "submits a normalized Waitlist email after %s",
  async (answer) => {
    submit.mockResolvedValue(answer);
    render(<Home onboarding={fake} />);
    sendForm();
    await screen.findByText(copy.answers[answer]);
    const email = screen.getByRole("textbox", { name: copy.waitlist.emailLabel });
    const button = screen.getByRole("button", { name: copy.waitlist.submit });
    expect(email).toHaveProperty("value", "");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button).toHaveProperty("disabled", true);
    fireEvent.change(email, { target: { value: "bad" } });
    expect(screen.getByRole("alert").textContent).toBe(copy.waitlist.invalidEmail);
    expect(email.getAttribute("aria-describedby")).toBe("waitlist-email-error");
    const form = button.closest("form")!;
    const event = new Event("submit", { bubbles: true, cancelable: true });
    fireEvent(form, event);
    expect(event.defaultPrevented).toBe(true);
    expect(joinWaitlist).not.toHaveBeenCalled();
    fireEvent.change(email, { target: { value: " Example@Email.COM " } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(email.getAttribute("aria-describedby")).toBeNull();
    fireEvent.submit(form);
    expect(await screen.findByText(copy.waitlist.success)).toBeTruthy();
    expect(joinWaitlist).toHaveBeenCalledWith({
      email: "example@email.com",
      locale: "ko",
      answer,
    });
    expect(screen.queryByRole("button", { name: copy.waitlist.submit })).toBeNull();
  },
);

it("keeps the Waitlist form pending until it settles and lets a failed request retry", async () => {
  submit.mockResolvedValue("full");
  let fail: ((reason: Error) => void) | undefined;
  joinWaitlist.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  render(<Home onboarding={fake} />);
  sendForm();
  await screen.findByText(copy.answers.full);
  fireEvent.change(screen.getByRole("textbox", { name: copy.waitlist.emailLabel }), {
    target: { value: "me@example.com" },
  });
  const button = screen.getByRole("button", { name: copy.waitlist.submit });
  const form = button.closest("form")!;
  fireEvent.submit(form);
  expect(button).toHaveProperty("disabled", true);
  expect(screen.queryByText(copy.waitlist.failure)).toBeNull();
  fireEvent.submit(form);
  expect(joinWaitlist).toHaveBeenCalledTimes(1);
  await act(async () => fail?.(new Error("offline")));
  expect(screen.getByText(copy.waitlist.failure)).toBeTruthy();
  expect(button).toHaveProperty("disabled", false);
  fireEvent.submit(form);
  expect(screen.queryByText(copy.waitlist.failure)).toBeNull();
  expect(await screen.findByText(copy.waitlist.success)).toBeTruthy();
  expect(joinWaitlist).toHaveBeenCalledTimes(2);
});

it("normalizes an Apple ID email", async () => {
  submit.mockResolvedValue("sent");
  render(<Home onboarding={fake} />);
  fillForm(" A.User@Example.COM ");
  fireEvent.click(screen.getByRole("button", { name: copy.form.submit }));
  await screen.findByText(copy.answers.sent);
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ handle: "a.user@example.com" }));
});

it("stays pending until the request settles and refuses a second submit", async () => {
  let finish: ((answer: "sent") => void) | undefined;
  submit.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<Home onboarding={fake} />);
  fillForm();
  const form = screen.getByRole("button", { name: copy.form.submit }).closest("form")!;
  fireEvent.submit(form);
  expect(screen.getByRole("status").textContent).toBe(copy.form.inProgress);
  expect(screen.getByRole("button", { name: copy.form.submit })).toHaveProperty("disabled", true);
  fireEvent.submit(form);
  expect(submit).toHaveBeenCalledTimes(1);
  await act(async () => finish?.("sent"));
  expect(screen.queryByText(copy.form.inProgress)).toBeNull();
  expect(screen.getByText(copy.answers.sent)).toBeTruthy();
});

it("treats a failed request as try_later", async () => {
  submit.mockRejectedValueOnce(new Error("offline"));
  render(<Home onboarding={fake} />);
  sendForm();
  expect(await screen.findByText(copy.answers.try_later)).toBeTruthy();
});

it("clears the last answer on retry while waiting", async () => {
  submit.mockResolvedValueOnce("sent");
  submit.mockImplementationOnce(() => new Promise(() => {}));
  render(<Home onboarding={fake} />);
  sendForm();
  expect(await screen.findByText(copy.answers.sent)).toBeTruthy();
  act(() => widgetOptions.callback("fresh-token"));
  fireEvent.click(screen.getByRole("button", { name: copy.form.submit }));
  expect(screen.getByRole("status").textContent).toBe(copy.form.inProgress);
  expect(screen.queryByText(copy.answers.sent)).toBeNull();
});

it("loads Turnstile when its script arrives after the form mounts", () => {
  const { append, view, script } = mountBeforeScript();
  expect(script.src).toContain("challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
  expect(script.async).toBe(true);
  window.turnstile = { render: vi.fn<Widget["render"]>(() => "late-widget"), remove };
  fireEvent.load(script);
  expect(window.turnstile.render).toHaveBeenCalled();
  view.unmount();
  expect(remove).toHaveBeenCalledWith("late-widget");
  expect(document.head.contains(script)).toBe(false);
  append.mockRestore();
});

it("does not render a widget if the script loads without Turnstile", () => {
  const { append, view, script } = mountBeforeScript();
  const removeListener = vi.spyOn(script, "removeEventListener");
  const removeScript = vi.spyOn(script, "remove");
  fireEvent.load(script);
  view.unmount();
  expect(remove).not.toHaveBeenCalled();
  expect(removeListener).toHaveBeenCalledWith("load", expect.any(Function));
  expect(removeScript).toHaveBeenCalledTimes(1);
  append.mockRestore();
});

it("cleans up if the widget script disappears or returns no widget", () => {
  window.turnstile = { render: vi.fn<Widget["render"]>(() => ""), remove };
  const first = render(<Home onboarding={fake} />);
  first.unmount();
  expect(remove).not.toHaveBeenCalled();
  window.turnstile = { render: vi.fn<Widget["render"]>(() => "widget"), remove };
  const second = render(<Home onboarding={fake} />);
  delete window.turnstile;
  second.unmount();
  expect(remove).not.toHaveBeenCalled();
  const { append, view: third, script } = mountBeforeScript();
  window.turnstile = { render: vi.fn<Widget["render"]>(() => "widget"), remove };
  fireEvent.load(script);
  delete window.turnstile;
  third.unmount();
  expect(remove).not.toHaveBeenCalled();
  append.mockRestore();
});

it("does not remove an empty widget ID after a late script load", () => {
  const { append, view, script } = mountBeforeScript();
  window.turnstile = { render: vi.fn<Widget["render"]>(() => ""), remove };
  fireEvent.load(script);
  view.unmount();
  expect(remove).not.toHaveBeenCalled();
  append.mockRestore();
});

it("rebinds Turnstile callbacks when the token handler changes", () => {
  const first = vi.fn<(token: string) => void>();
  const second = vi.fn<(token: string) => void>();
  const widget = window.turnstile!;
  const view = render(<Turnstile onToken={first} />);
  const previous = widgetOptions.callback;
  view.rerender(<Turnstile onToken={second} />);
  act(() => widgetOptions.callback("updated"));
  expect(widget.render).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenCalledWith("widget-id");
  expect(second).toHaveBeenCalledWith("updated");
  expect(previous).not.toBe(widgetOptions.callback);
});

it("navigates both routes through the in-memory router with a fake API", async () => {
  const router = getRouter(fake);
  router.update({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { onboarding: fake },
  });
  render(<RouterProvider router={router} />, { container: document });
  expect(await screen.findByRole("heading", { name: copy.home.title })).toBeTruthy();
  await act(() => router.navigate({ to: "/privacy" }));
  expect(await screen.findByRole("heading", { name: copy.privacy.title })).toBeTruthy();
});

it("posts the shared request and validates the API answer", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify("sent")));
  vi.stubGlobal("fetch", fetcher);
  const request = {
    handle: "+821012345678",
    locale: "ko",
    privacyNoticeVersion: "v1",
    turnstileToken: "token",
  } as const;
  expect(await onboardingClient.submit(request)).toBe("sent");
  expectPost("onboarding", request);
  fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(onboardingClient.submit(request)).rejects.toThrow("Onboarding request failed");
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify("unexpected")));
  await expect(onboardingClient.submit(request)).rejects.toThrow("Expected");
});

it("posts the shared Waitlist request through the API client", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const request = { email: "me@example.com", locale: "ko", answer: "unknown" } as const;
  await onboardingClient.joinWaitlist(request);
  expectPost("waitlist", request);
  fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(onboardingClient.joinWaitlist(request)).rejects.toThrow("Waitlist request failed");
});

it("shows try_later for an unexpected API answer", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify("surprise"))),
  );
  render(<Home onboarding={onboardingClient} />);
  sendForm();
  expect(await screen.findByText(copy.answers.try_later)).toBeTruthy();
});
