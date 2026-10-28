import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { discoveryNotice } from "@ren-ai/onboarding";
import { Site } from "./site.tsx";
import { discoveryClient, type DiscoveryClient } from "./client.ts";
import { publicPersonas } from "../test/public-personas.ts";
import { choose, selectImageStyle, selectDropdown } from "../test/choose.ts";
import { readPublicBootstrap, publicRoute } from "./public-routing.ts";
import { testClient } from "../test/client.ts";

let verification: ((token: string) => void) | undefined;
beforeEach(() => {
  window.turnstile = {
    render: (_, options) => {
      verification = options.callback;
      return "widget";
    },
    remove: () => {},
  };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.getElementById("public-personas")?.remove();
  delete window.turnstile;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function mount(bootstrap = true) {
  window.history.replaceState(null, "", "/personas/jia?style=photo");
  const api = {
    profiles: vi.fn<DiscoveryClient["profiles"]>().mockResolvedValue(publicPersonas.toReversed()),
    join: vi.fn<DiscoveryClient["join"]>().mockResolvedValue({ status: "waiting" }),
  };
  if (bootstrap) {
    const script = document.createElement("script");
    script.id = "public-personas";
    script.type = "application/json";
    script.textContent = JSON.stringify({ people: publicPersonas.toReversed() });
    document.body.append(script);
  }
  render(<Site client={testClient(api)} />);
  return api;
}

function consentAndVerify(token: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "이름" }), { target: { value: "민수" } });
  fireEvent.change(screen.getByRole("textbox", { name: "휴대전화 번호" }), {
    target: { value: "01012345678" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: discoveryNotice.consent }));
  act(() => verification!(token));
}

test("a shared URL opens the target in the original Discovery reading view and collapses back to the same prioritized card", async () => {
  const api = mount();
  expect(api.profiles).not.toHaveBeenCalled();
  const details = screen.getByRole("region", { name: /백지아/ });
  expect(within(details).getByText("햇살 좋은 날엔 같이 걸어요.")).toBeTruthy();
  expect(within(details).getByRole("img", { name: "백지아 프로필" }).getAttribute("src")).toBe(
    "https://persona-images.renai.im/thumbnails/00000000-0000-0000-0000-000000000002.jpg",
  );
  expect(document.querySelector(".discovery-shell")).toBeTruthy();
  expect(document.querySelector(".public-site")).toBeNull();
  expect(screen.queryByRole("link", { name: "페르소나 둘러보기" })).toBeNull();
  expect(document.title).toBe("백지아 — Ren AI의 AI 페르소나");
  await selectImageStyle("애니메");
  expect(window.location.search).toBe("?style=anime&preview=v2");
  fireEvent.click(within(details).getByRole("button", { name: "다음 사진" }));
  fireEvent.click(screen.getByRole("button", { name: "프로필 접기" }));
  expect(window.location.pathname).toBe("/explore");
  expect(screen.getByRole("img", { name: "백지아 프로필" }).getAttribute("src")).toBe(
    "https://persona-images.renai.im/thumbnails/00000000-0000-0000-0000-000000000003.jpg",
  );
  choose(false);
  expect(screen.getByRole("heading", { name: "한수빈" })).toBeTruthy();
});

test("previously passed shared personas can be Liked without losing siblings, then join through the normal Discovery form", async () => {
  localStorage.setItem("ren-ai.discovery.choices", JSON.stringify({ jia: false, subin: true }));
  const api = mount();
  choose(true);
  expect(JSON.parse(localStorage.getItem("ren-ai.discovery.choices")!)).toEqual({
    jia: true,
    subin: true,
  });
  expect(window.location.pathname).toBe("/explore");
  fireEvent.click(screen.getByRole("button", { name: "연락받기" }));
  expect(
    within(screen.getByRole("list", { name: "관심을 전할 페르소나" })).getAllByRole("listitem"),
  ).toHaveLength(2);
  consentAndVerify("passed");
  await act(async () =>
    fireEvent.submit(screen.getByRole("button", { name: "동의하고 대기 등록" }).closest("form")!),
  );
  expect(api.join).toHaveBeenCalledWith(
    expect.objectContaining({ likedPersonaIDs: ["jia", "subin"], handle: "+821012345678" }),
  );
  expect(screen.getByRole("heading", { name: "대기 등록이 완료됐어요." })).toBeTruthy();
});

test("explore cards have no sharing action; opening details exposes footer sharing without private fragments", async () => {
  const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { languages: ["ko-KR"], clipboard: { writeText } });
  mount();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}#reselect=private-token`,
  );
  fireEvent.click(screen.getByRole("button", { name: "프로필 접기" }));
  expect(window.location.pathname).toBe("/explore");
  expect(screen.queryByRole("button", { name: "프로필 공유하기" })).toBeNull();
  expect(screen.queryByRole("region", { name: /백지아/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "백지아 소개 전체 보기" }));
  expect(window.location.pathname).toBe("/personas/jia");
  const button = screen.getByRole("button", { name: "프로필 공유하기" });
  expect(button.closest(".details-footer")).toBeTruthy();
  fireEvent.click(button);
  await screen.findByText("링크를 복사했어요.");
  expect(writeText).toHaveBeenCalledWith("https://renai.im/personas/jia?style=photo&preview=v2");
  expect(screen.getByRole("region", { name: /백지아/ })).toBeTruthy();
  expect(localStorage.getItem("ren-ai.discovery.choices")).toBeNull();
  expect(window.location.hash).toBe("#reselect=private-token");
});

test("local direct entry loads the Catalog, retains authored writing across locale changes, and handles missing profiles", async () => {
  const api = mount(false);
  await screen.findByRole("region", { name: /백지아/ });
  expect(api.profiles).toHaveBeenCalledTimes(2);
  selectDropdown("화면 언어", "English");
  expect(screen.getByText("햇살 좋은 날엔 같이 걸어요.")).toBeTruthy();
  cleanup();
  window.history.replaceState(null, "", "/personas/missing");
  render(<Site client={testClient(api)} />);
  await screen.findByRole("heading", { name: "This profile isn't public." });
  expect(screen.getByRole("link", { name: "Back to profiles" }).getAttribute("href")).toBe(
    "/explore",
  );
});

test("reselection reloads its private Catalog before browsing and submits only eligible Likes after a retry", async () => {
  const token = "a".repeat(64);
  window.history.replaceState(null, "", `/explore#reselect=${token}`);
  localStorage.setItem("ren-ai.discovery.choices", JSON.stringify({ jia: true }));
  const script = document.createElement("script");
  script.id = "public-personas";
  script.type = "application/json";
  script.textContent = JSON.stringify({ people: publicPersonas });
  document.body.append(script);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json({ people: [publicPersonas[1]], nextCursor: null }))
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json({ status: "waiting" }));
  vi.stubGlobal("fetch", fetcher);
  render(<Site client={{ ...discoveryClient, activity: async () => {} }} />);
  expect(screen.getByText("만날 사람들을 불러오고 있어요.")).toBeTruthy();
  expect(screen.queryByText("백지아")).toBeNull();
  await screen.findByRole("heading", { name: "프로필을 불러오지 못했어요." });
  expect(screen.queryByText("백지아")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
  await screen.findByRole("heading", { name: "한수빈" });
  expect(screen.queryByText("백지아")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(4);
  for (const [url, options] of fetcher.mock.calls.filter((_, index) => index % 2 === 0)) {
    expect(url).toBe("/discovery/reselection/personas");
    expect(options).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ locale: "ko", reselectionToken: token }),
      cache: "no-store",
    });
  }
  choose(true);
  fireEvent.click(screen.getByRole("button", { name: "연락받기" }));
  expect(screen.getByRole("list", { name: "관심을 전할 페르소나" }).textContent).toBe("한수빈");
  consentAndVerify("reselection");
  fireEvent.submit(screen.getByRole("button", { name: "동의하고 대기 등록" }).closest("form")!);
  await screen.findByRole("heading", { name: "대기 등록이 완료됐어요." });
  const body = fetcher.mock.calls[4]![1]!.body;
  if (typeof body !== "string") throw new Error("Expected a JSON request body");
  expect(JSON.parse(body)).toMatchObject({
    likedPersonaIDs: ["subin"],
    reselectionToken: token,
  });
  expect(script.textContent).toBe(JSON.stringify({ people: publicPersonas }));
  expect(window.location.hash).toBe(`#reselect=${token}`);
  expect(localStorage.getItem("ren-ai.discovery.choices")).not.toContain(token);
});

test("a reselection profile URL cannot reopen an ended persona and retains the token when returning to explore", async () => {
  const token = "b".repeat(64);
  const api = mount();
  cleanup();
  window.history.replaceState(null, "", `/personas/jia#reselect=${token}`);
  api.profiles.mockResolvedValue([publicPersonas[1]!]);
  render(<Site client={testClient(api)} />);
  expect(screen.queryByRole("region", { name: /백지아/ })).toBeNull();
  await screen.findByRole("heading", { name: "이 프로필은 공개되어 있지 않아요." });
  expect(api.profiles).toHaveBeenCalledWith(expect.any(AbortSignal), token, ["jia"]);
  expect(screen.queryByText("백지아")).toBeNull();
  expect(screen.getByRole("link", { name: "탐색으로 돌아가기" }).getAttribute("href")).toBe(
    `/explore#reselect=${token}`,
  );
});

test("public bootstrap parsing narrows input and rejects malformed JSON and non-profile fields", () => {
  expect(readPublicBootstrap(null)).toBeUndefined();
  expect(() => readPublicBootstrap("bad JSON")).toThrow(SyntaxError);
  expect(() => readPublicBootstrap('{"people":[{"private":"bad"}]}')).toThrow(/id/);
  expect(() =>
    readPublicBootstrap('{"people":[],"page":{"locale":"fr","nextCursor":null}}'),
  ).toThrow(/locale/);
  expect(publicRoute(new URL("https://renai.im/personas/bad/id?style=invalid"))).toEqual({
    id: undefined,
    style: undefined,
  });
});
