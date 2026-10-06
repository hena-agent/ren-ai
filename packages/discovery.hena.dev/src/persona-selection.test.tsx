import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Home } from "./pages/home.tsx";
import { copy } from "./copy.ts";
import { widget, widgetOptions } from "./turnstile.fake.ts";
import { onboardingClient } from "./onboarding-client.ts";
import type { OnboardingClient } from "./onboarding-client.ts";

beforeEach(() => {
  window.turnstile = widget;
});
afterEach(() => {
  cleanup();
  delete window.turnstile;
  vi.unstubAllGlobals();
});

const profiles = [
  { id: "harin", name: "하린", bio: "29살 사진가", imageUrl: "https://example.com/harin.jpg" },
  { id: "seoyeon", name: "서연", bio: "33살 간호사", imageUrl: "" },
];
const client = (overrides: Partial<OnboardingClient> = {}): OnboardingClient => ({
  catalog: async () => profiles,
  submit: async () => "sent",
  joinWaitlist: async () => {},
  ...overrides,
});

const pendingCatalog = () => {
  type Catalog = Awaited<ReturnType<OnboardingClient["catalog"]>>;
  let resolve: ((list: Catalog) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<Catalog>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return {
    promise,
    resolve: (list: Catalog) => resolve!(list),
    reject: (error: Error) => reject!(error),
  };
};

function submitHandle() {
  fireEvent.change(screen.getByRole("textbox", { name: copy.form.handleLabel }), {
    target: { value: "01012345678" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  act(() => widgetOptions.callback("human"));
  fireEvent.click(screen.getByRole("button", { name: copy.form.submit }));
}

test("a user chooses a persona before submitting a handle", async () => {
  const submit = vi.fn<OnboardingClient["submit"]>().mockResolvedValue("sent");
  render(<Home onboarding={client({ submit })} />);
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: /서연/ }));
  submitHandle();
  expect(await screen.findByText(copy.answers.sent)).toBeTruthy();
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ personaID: "seoyeon", handle: "+821012345678" }),
  );
});

test("selection can be changed before onboarding and photos are optional", async () => {
  render(<Home onboarding={client()} />);
  const harin = await screen.findByRole("button", { name: /하린/ });
  expect(harin.querySelector("img")).toHaveProperty("src", profiles[0]!.imageUrl);
  expect(screen.getByRole("button", { name: /서연/ }).querySelector("img")).toBeNull();
  fireEvent.click(harin);
  fireEvent.click(screen.getByRole("button", { name: "다른 사람 고르기" }));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(await screen.findByRole("button", { name: /서연/ })).toBeTruthy();
});

test("catalog loading has a status and a failed load can retry to an empty catalog", async () => {
  const pending = pendingCatalog();
  const catalog = vi
    .fn<OnboardingClient["catalog"]>()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce([]);
  render(<Home onboarding={client({ catalog })} />);
  expect(screen.getByRole("status").textContent).toBe("목록을 불러오는 중이에요.");
  await act(async () => pending.reject(new Error("offline")));
  expect(screen.getByRole("alert").textContent).toContain("목록을 불러오지 못했어요.");
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByText("아직 대화할 수 있는 사람이 없어요.")).toBeTruthy();
  expect(catalog).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("textbox")).toBeNull();
});

test.each(["resolve", "reject"] as const)(
  "a catalog request that finishes after leaving the page is ignored (%s)",
  async (finish) => {
    const pending = pendingCatalog();
    const view = render(<Home onboarding={client({ catalog: () => pending.promise })} />);
    view.unmount();
    await act(async () => {
      if (finish === "resolve") pending.resolve(profiles);
      else pending.reject(new Error("offline"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  },
);

test("a persona unavailable at submission explains the answer and reloads the published catalog", async () => {
  const catalog = vi
    .fn<OnboardingClient["catalog"]>()
    .mockResolvedValueOnce(profiles)
    .mockResolvedValueOnce([profiles[1]!]);
  render(<Home onboarding={client({ catalog, submit: async () => "persona_unavailable" })} />);
  fireEvent.click(await screen.findByRole("button", { name: /하린/ }));
  submitHandle();
  expect(await screen.findByText(copy.answers.persona_unavailable)).toBeTruthy();
  expect(await screen.findByRole("button", { name: /서연/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /하린/ })).toBeNull();
  expect(catalog).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: /서연/ }));
  expect(screen.queryByText(copy.answers.persona_unavailable)).toBeNull();
});

test("the catalog client loads and validates public profiles and rejects HTTP failures", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(profiles));
  vi.stubGlobal("fetch", fetcher);
  expect(await onboardingClient.catalog()).toEqual(profiles);
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://api-msg.hena.dev/personas");
  expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(onboardingClient.catalog()).rejects.toThrow("Catalog request failed");
  fetcher.mockResolvedValueOnce(Response.json([{ id: "broken" }]));
  await expect(onboardingClient.catalog()).rejects.toThrow("Missing key");
});

test("an old API without a catalog still onboards through the handle form without selecting or submitting a persona", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json("sent"));
  vi.stubGlobal("fetch", fetcher);
  expect(await onboardingClient.catalog()).toBeUndefined();
  render(<Home onboarding={onboardingClient} />);
  await screen.findByRole("textbox", { name: copy.form.handleLabel });
  expect(screen.queryByText(copy.catalog.title)).toBeNull();
  expect(screen.queryByRole("button", { name: copy.catalog.change })).toBeNull();
  submitHandle();
  expect(await screen.findByText(copy.answers.sent)).toBeTruthy();
  expect(fetcher.mock.calls[2]?.[0]).toBe("https://api-msg.hena.dev/onboarding");
  expect(fetcher.mock.calls[2]?.[1]?.body).toBe(
    JSON.stringify({
      handle: "+821012345678",
      locale: "ko",
      privacyNoticeVersion: copy.privacyNoticeVersion,
      turnstileToken: "human",
    }),
  );
});

test.each(["server", "network"] as const)(
  "a %s catalog failure offers retry rather than legacy onboarding",
  async (failure) => {
    const fetcher = vi.fn<typeof fetch>();
    if (failure === "server") fetcher.mockResolvedValueOnce(new Response(null, { status: 500 }));
    else fetcher.mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetcher);
    render(<Home onboarding={onboardingClient} />);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining(copy.catalog.failure),
    );
    expect(screen.getByRole("button", { name: copy.catalog.retry })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
