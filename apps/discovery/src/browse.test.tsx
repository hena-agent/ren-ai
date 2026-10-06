import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./app.tsx";
import type { DiscoveryClient } from "./client.ts";
import type { PublicPersona } from "@ren-ai/onboarding";
import { choose, endAnimation } from "../test/choose.ts";

beforeEach(() => {
  localStorage.setItem("ren-ai.discovery.image-style", "photo");
  window.turnstile = { render: () => "widget", remove: () => {} };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete window.turnstile;
});
const profiles: readonly PublicPersona[] = [
  {
    id: "mika",
    name: "미카",
    bio: "주말에는 바다를 보러 가요.",
    imageUrl: "https://example.org/mika.jpeg",
  },
  {
    id: "bora",
    name: "보라",
    bio: "작은 정원을 가꿔요.",
    imageUrl: "https://example.org/bora.jpeg",
  },
];
const join = vi.fn<DiscoveryClient["join"]>();
const client: DiscoveryClient = { profiles: async () => profiles, join };

async function passAllProfiles() {
  render(<App client={client} />);
  await screen.findByRole("heading", { name: /어떤 느낌|미카/ });
  const picker = screen.queryByRole("heading", { name: "어떤 느낌으로 만나볼까요?" });
  if (picker) fireEvent.click(screen.getByRole("button", { name: /실사/ }));
  await screen.findByRole("heading", { name: "미카" });
  for (const _ of profiles) choose(false);
  await screen.findByRole("heading", { name: "오늘의 프로필을 모두 봤어요." });
}

test("Pass and Like survive a reload, and revisiting passed cards preserves Likes", async () => {
  const first = render(<App client={client} />);
  await screen.findByRole("heading", { name: "미카" });
  expect(
    screen.queryByText("이 브라우저에 선택을 보관하지 못했어요. 지금 등록은 계속할 수 있어요."),
  ).toBeNull();
  choose(false);
  await screen.findByRole("heading", { name: "보라" });
  choose(true);
  await screen.findByRole("heading", { name: "오늘의 프로필을 모두 봤어요." });
  expect(screen.getByText("마음에 든 사람이 있다면 연락을 기다려 볼까요?")).toBeTruthy();
  first.unmount();
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "오늘의 프로필을 모두 봤어요." });
  fireEvent.click(screen.getByRole("button", { name: "다시 둘러보기" }));
  await screen.findByRole("heading", { name: "미카" });
  expect(
    screen.queryByText("이 브라우저에 선택을 보관하지 못했어요. 지금 등록은 계속할 수 있어요."),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /연락받기/ }));
  expect(screen.getByRole("list", { name: "관심을 전할 페르소나" }).textContent).toBe("보라");
  fireEvent.click(screen.getByRole("button", { name: /탐색으로 돌아가기/ }));
  expect(screen.getByRole("heading", { name: "미카" })).toBeTruthy();
  expect(document.querySelector(".app-workspace")?.getAttribute("data-view")).toBe("browse");
});

test("no Likes leaves registration disabled, including after all cards are passed", async () => {
  await passAllProfiles();
  expect(screen.getByText("아직 마음에 드는 사람이 없나요? 다시 둘러볼 수 있어요.")).toBeTruthy();
  expect(screen.getByRole("button", { name: /연락받기/ }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: "좋아요" })).toBeNull();
  expect(screen.queryByRole("button", { name: "넘기기" })).toBeNull();
});

test("catalog failures can be retried and an empty catalog has a clear state", async () => {
  const load = vi
    .fn<DiscoveryClient["profiles"]>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce([]);
  render(<App client={{ profiles: load, join }} />);
  expect(screen.getByText("만날 사람들을 불러오고 있어요.")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "프로필을 불러오지 못했어요." })).toBeNull();
  await screen.findByRole("heading", { name: "프로필을 불러오지 못했어요." });
  expect(screen.queryByText("만날 사람들을 불러오고 있어요.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
  expect(screen.getByText("만날 사람들을 불러오고 있어요.")).toBeTruthy();
  await screen.findByRole("heading", { name: "새로운 만남을 준비하고 있어요." });
  expect(
    screen.getByText("아직 공개된 페르소나가 없어요. 조금 뒤에 다시 들러 주세요."),
  ).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
});

test("the real client is used by default and inherited property names are valid persona IDs", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json([{ ...profiles[0]!, id: "constructor" }]));
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  await screen.findByRole("heading", { name: "미카" });
  choose(true);
  await screen.findByRole("heading", { name: "오늘의 프로필을 모두 봤어요." });
  expect(screen.queryByRole("button", { name: "다시 둘러보기" })).toBeNull();
  expect(screen.getByRole("button", { name: /연락받기/ }).hasAttribute("disabled")).toBe(false);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/discovery/personas");
  expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
});

test("fast repeated selection cannot overwrite a Like or advance two profiles", async () => {
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "미카" });
  const surface = screen.getByRole("button", { name: "미카 소개 전체 보기" });
  const like = screen.getByRole("button", { name: "좋아요" });
  act(() => {
    like.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  });
  endAnimation(surface.closest("article")!);
  await screen.findByRole("heading", { name: "보라" });
  expect(JSON.parse(localStorage.getItem("ren-ai.discovery.choices") ?? "{}")).toEqual({
    mika: true,
  });
});

test("storage failures do not block choosing or revisiting a profile", async () => {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn<Storage["getItem"]>().mockReturnValue(null),
    setItem: vi.fn<Storage["setItem"]>().mockImplementation(() => {
      throw new Error("blocked");
    }),
  });
  await passAllProfiles();
  expect(
    screen.getByText("이 브라우저에 선택을 보관하지 못했어요. 지금 등록은 계속할 수 있어요."),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다시 둘러보기" }));
  await screen.findByRole("heading", { name: "미카" });
  expect(
    screen.getByText("이 브라우저에 선택을 보관하지 못했어요. 지금 등록은 계속할 수 있어요."),
  ).toBeTruthy();
  choose(true);
  expect(screen.getByRole("button", { name: /연락받기/ }).hasAttribute("disabled")).toBe(false);
});

test("stale catalog results and failures cannot replace a newer catalog or revive an unmounted view", async () => {
  let resolve: (people: readonly PublicPersona[]) => void =
    vi.fn<(people: readonly PublicPersona[]) => void>();
  let reject: (reason: Error) => void = vi.fn<(reason: Error) => void>();
  let oldSignal: AbortSignal | undefined;
  const slow: DiscoveryClient = {
    profiles: (signal) => {
      oldSignal = signal;
      return new Promise((ready) => {
        resolve = ready;
      });
    },
    join,
  };
  const view = render(<App client={slow} />);
  view.rerender(<App client={client} />);
  await screen.findByRole("heading", { name: "미카" });
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => resolve([]));
  expect(screen.getByRole("heading", { name: "미카" })).toBeTruthy();
  const failing: DiscoveryClient = {
    profiles: (signal) => {
      oldSignal = signal;
      return new Promise((_, fail) => {
        reject = fail;
      });
    },
    join,
  };
  view.rerender(<App client={failing} />);
  view.rerender(<App client={client} />);
  await act(async () => reject(new Error("stale")));
  expect(screen.queryByRole("heading", { name: "프로필을 불러오지 못했어요." })).toBeNull();
  view.unmount();
  expect(oldSignal?.aborted).toBe(true);
});
