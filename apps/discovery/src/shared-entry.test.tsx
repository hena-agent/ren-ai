import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { discoveryNotice } from "@ren-ai/onboarding";
import { Site } from "./site.tsx";
import type { DiscoveryClient } from "./client.ts";
import { publicPersonas } from "../test/public-personas.ts";
import { choose, selectImageStyle, selectLanguage } from "../test/choose.ts";
import { readPublicPeople, publicRoute } from "./public-routing.ts";

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
    script.textContent = JSON.stringify(publicPersonas.toReversed());
    document.body.append(script);
  }
  render(<Site client={api} />);
  return api;
}

test("a shared URL opens the target in the original Discovery reading view and collapses back to the same prioritized card", async () => {
  const api = mount();
  expect(api.profiles).not.toHaveBeenCalled();
  const details = screen.getByRole("region", { name: /백지아/ });
  expect(within(details).getByText("햇살 좋은 날엔 같이 걸어요.")).toBeTruthy();
  expect(within(details).getByRole("img", { name: "백지아 프로필" }).getAttribute("src")).toContain(
    "jia-photo",
  );
  expect(document.querySelector(".discovery-shell")).toBeTruthy();
  expect(document.querySelector(".public-site")).toBeNull();
  expect(screen.queryByRole("link", { name: "페르소나 둘러보기" })).toBeNull();
  expect(document.title).toBe("백지아 — Ren AI의 AI 페르소나");
  await selectImageStyle("애니메");
  expect(window.location.search).toBe("?style=anime");
  fireEvent.click(within(details).getByRole("button", { name: "다음 사진" }));
  fireEvent.click(screen.getByRole("button", { name: "프로필 접기" }));
  expect(window.location.pathname).toBe("/explore");
  expect(screen.getByRole("img", { name: "백지아 프로필" }).getAttribute("src")).toContain(
    "jia-walk",
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
  fireEvent.click(screen.getByRole("button", { name: /연락받기/ }));
  expect(
    within(screen.getByRole("list", { name: "관심을 전할 페르소나" })).getAllByRole("listitem"),
  ).toHaveLength(2);
  fireEvent.change(screen.getByRole("textbox", { name: "휴대전화 번호" }), {
    target: { value: "01012345678" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: discoveryNotice.consent }));
  act(() => verification!("passed"));
  await act(async () =>
    fireEvent.submit(screen.getByRole("button", { name: "동의하고 대기 등록" }).closest("form")!),
  );
  expect(api.join).toHaveBeenCalledWith(
    expect.objectContaining({ likedPersonaIDs: ["jia", "subin"], handle: "+821012345678" }),
  );
  expect(screen.getByRole("heading", { name: "대기 등록이 완료됐어요." })).toBeTruthy();
});

test("sharing a compact card does not select or expand it, and shared public URLs never contain private fragments", async () => {
  const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { languages: ["ko-KR"], clipboard: { writeText } });
  mount();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}#reselect=private-token`,
  );
  fireEvent.click(screen.getByRole("button", { name: "프로필 접기" }));
  fireEvent.click(screen.getByRole("button", { name: "공유하기" }));
  await screen.findByText("링크를 복사했어요.");
  expect(writeText).toHaveBeenCalledWith("https://renai.im/personas/jia?style=photo");
  expect(screen.queryByRole("region", { name: /백지아/ })).toBeNull();
  expect(localStorage.getItem("ren-ai.discovery.choices")).toBeNull();
  expect(window.location.hash).toBe("#reselect=private-token");
});

test("local direct entry loads the Catalog, retains authored writing across locale changes, and handles missing profiles", async () => {
  const api = mount(false);
  await screen.findByRole("region", { name: /백지아/ });
  expect(api.profiles).toHaveBeenCalledOnce();
  selectLanguage("화면 언어", "English");
  expect(screen.getByText("햇살 좋은 날엔 같이 걸어요.")).toBeTruthy();
  cleanup();
  window.history.replaceState(null, "", "/personas/missing");
  render(<Site client={api} />);
  await screen.findByRole("heading", { name: "This profile isn't public." });
  expect(screen.getByRole("link", { name: "Back to profiles" }).getAttribute("href")).toBe(
    "/explore",
  );
});

test("public bootstrap parsing narrows input and rejects malformed JSON and non-profile fields", () => {
  expect(readPublicPeople(null)).toBeUndefined();
  expect(() => readPublicPeople("bad JSON")).toThrow(SyntaxError);
  expect(() => readPublicPeople('[{"private":"bad"}]')).toThrow(/id/);
  expect(publicRoute(new URL("https://renai.im/personas/bad/id?style=invalid"))).toEqual({
    id: undefined,
    style: undefined,
  });
});
