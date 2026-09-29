import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as onboarding from "@ren-ai/onboarding";
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
import { widget, widgetOptions } from "./turnstile.fake.ts";

const submit = vi.fn<OnboardingClient["submit"]>();
const joinWaitlist = vi.fn<OnboardingClient["joinWaitlist"]>();
const fake: OnboardingClient = { submit, joinWaitlist };
const approvedVersion = copy.privacyNoticeVersion;

beforeEach(() => {
  vi.clearAllMocks();
  copy.privacyNoticeVersion = approvedVersion;
  submit.mockReset();
  joinWaitlist.mockReset();
  window.turnstile = widget;
});

afterEach(() => {
  copy.privacyNoticeVersion = approvedVersion;
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
  expect(turnstileSiteKey).toBe("1x00000000000000000000BB");
  expect(screen.getByRole("textbox", { name: copy.form.handleLabel })).toHaveProperty("value", "");
  expect(screen.queryByRole("alert")).toBeNull();
  view.unmount();
  expect(widget.remove).toHaveBeenCalledWith("widget-id");
  render(<Privacy />);
  expect(screen.getByRole("heading", { name: copy.privacy.title })).toBeTruthy();
  expect(screen.getByText(approvedVersion)).toBeTruthy();
  expect(screen.getByRole("link", { name: copy.privacy.homeLink })).toHaveProperty("pathname", "/");
});

it("publishes the approved privacy sections, deletion scope, and removal contact", () => {
  render(<Privacy />);
  expect(screen.getByText(/iMessage에서 AI 캐릭터와 대화하는 시험 서비스/)).toBeTruthy();
  expect(screen.getByText(/첫 메시지는 서비스가 보내는 AI 안내/)).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(
    copy.privacy.sections.length + 1,
  );
  expect(screen.getByText(/자동 만료 기한 없이 보관/)).toBeTruthy();
  expect(screen.getByText(/대기 명단에서 삭제/)).toBeTruthy();
  expect(screen.getByText(/Apple Messages의 대화 기록/)).toBeTruthy();
  expect(screen.getByText(/14일이 지난 백업/)).toBeTruthy();
  expect(screen.getByText(/2026년 9월 30일까지/)).toBeTruthy();
  expect(screen.getByText(/실제 데이터 처리 국가와 지역은 현재 확인되지 않았습니다/)).toBeTruthy();
  expect(screen.getByText(/https:\/\/www.cloudflare.com\/turnstile-privacy-policy\//)).toBeTruthy();
  expect(screen.queryByText(copy.privacy.placeholder)).toBeNull();
  expect(screen.getByRole("link", { name: "hi@hena.dev" })).toHaveProperty(
    "href",
    "mailto:hi@hena.dev",
  );
  for (const section of copy.privacy.sections) {
    expect(screen.getByRole("heading", { name: section.title, level: 2 })).toBeTruthy();
    for (const paragraph of section.paragraphs) expect(screen.getByText(paragraph)).toBeTruthy();
  }
  expect(copy.privacy.sections.flatMap((section) => section.paragraphs).join(" ")).not.toMatch(
    /\[[^\]]+\]/,
  );
});

it("uses the deployed Turnstile key when the build variable is set", async () => {
  vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "deployed-widget-key");
  vi.resetModules();
  expect((await import("./config.ts")).turnstileSiteKey).toBe("deployed-widget-key");
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("normalizes the Handle using the country selected from the shared rules", () => {
  const normalize = vi.spyOn(onboarding, "normalizeHandle");
  Reflect.set(onboarding.countries, "TEST", { dialCode: "1", local: /^01012345678$/ });
  try {
    render(<Home onboarding={fake} />);
    const select = screen.getByRole("combobox", { name: copy.form.countryLabel });
    expect(Array.from(select.querySelectorAll("option"), (option) => option.value)).toEqual(
      Object.keys(onboarding.countries),
    );
    fireEvent.change(select, { target: { value: "TEST" } });
    fireEvent.change(screen.getByRole("textbox", { name: copy.form.handleLabel }), {
      target: { value: "01012345678" },
    });
    expect(select).toHaveProperty("value", "TEST");
    expect(normalize).toHaveBeenCalledWith("01012345678", "TEST");
    fireEvent.change(select, { target: { value: "invalid" } });
    fireEvent.change(screen.getByRole("textbox", { name: copy.form.handleLabel }), {
      target: { value: "0101234567" },
    });
    expect(select).toHaveProperty("value", "TEST");
  } finally {
    Reflect.deleteProperty(onboarding.countries, "TEST");
    normalize.mockRestore();
  }
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

it.each(["error-callback", "unsupported-callback"] as const)(
  "explains %s and clears the alert when verification recovers",
  (callback) => {
    render(<Home onboarding={fake} />);
    fillForm();
    const button = screen.getByRole("button", { name: copy.form.submit });
    act(() => widgetOptions[callback]());
    expect(screen.getByRole("alert").textContent).toBe(copy.form.verificationFailed);
    expect(button).toHaveProperty("disabled", true);
    fireEvent.submit(button.closest("form")!);
    expect(submit).not.toHaveBeenCalled();
    act(() => widgetOptions.callback("recovered"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button).toHaveProperty("disabled", false);
  },
);

it.each(["success", "failure"])("obtains a fresh token after a %s response", async (result) => {
  let finish: (() => void) | undefined;
  submit.mockImplementationOnce(
    () =>
      new Promise((resolve, reject) => {
        finish = () => (result === "success" ? resolve("sent") : reject(new Error("offline")));
      }),
  );
  render(<Home onboarding={fake} />);
  sendForm();
  expect(widget.remove).toHaveBeenCalledExactlyOnceWith("widget-id");
  expect(widget.render).toHaveBeenCalledTimes(1);
  await act(async () => finish?.());
  expect(widget.render).toHaveBeenCalledTimes(2);
  const button = screen.getByRole("button", { name: copy.form.submit });
  expect(button).toHaveProperty("disabled", true);
  act(() => widgetOptions.callback("fresh-token"));
  expect(button).toHaveProperty("disabled", false);
  submit.mockResolvedValueOnce("sent");
  fireEvent.click(button);
  await screen.findByText(copy.answers.sent);
  expect(submit).toHaveBeenLastCalledWith(
    expect.objectContaining({ turnstileToken: "fresh-token" }),
  );
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
