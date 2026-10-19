import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { discoveryNotices } from "@ren-ai/onboarding";
import { Site } from "./site.tsx";
import type { DiscoveryClient } from "./client.ts";
import { selectImageStyle, selectLanguage } from "../test/choose.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

test("the home explains the service without loading profiles and offers real navigation to Discovery", () => {
  const profiles = vi.fn<DiscoveryClient["profiles"]>().mockRejectedValue(new Error("offline"));
  render(<Site client={{ profiles, join: vi.fn<DiscoveryClient["join"]>() }} />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "일상에,기다려지는 메시지 하나.",
  );
  expect(profiles).not.toHaveBeenCalled();
  expect(document.querySelector(".discovery-shell")).toBeNull();
  for (const link of screen.getAllByRole("link", { name: "페르소나 만나보기" })) {
    expect(link.getAttribute("href")).toBe("/explore");
  }
  const nav = screen.getByRole("navigation", { name: "서비스 소개 메뉴" });
  for (const link of within(nav).getAllByRole("link")) {
    expect(document.querySelector(link.getAttribute("href")!)).toBeTruthy();
  }
  expect(document.querySelector("#discovery-content")).toBe(screen.getByRole("main"));
  expect(screen.getByRole("figure", { name: "서비스 이해를 위한 가상의 대화 예시" })).toBeTruthy();
  expect(screen.getByText(/등록이 즉시 연결을 보장하지는 않아요/)).toBeTruthy();
  expect(screen.getByText(/Android는 아직 지원하지 않아요/)).toBeTruthy();
  expect(document.querySelectorAll(".home-questions details")).toHaveLength(5);
  expect(screen.getByText(discoveryNotices.ko.title)).toBeTruthy();
  expect(document.title).toBe("Ren AI — 일상에, 기다려지는 메시지 하나");
  expect(screen.getByRole("heading", { name: "페르소나가 연락할 거예요" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "새 앱 말고, 늘 쓰던 메시지에서." })).toBeTruthy();
  expect(screen.getByRole("heading", { name: /오직\s*당신\s*과만\./ })).toBeTruthy();
  expect(screen.getByText("당신과 연결된 페르소나는 다른 누구와도 대화하지 않아요.")).toBeTruthy();
  expect(screen.getByRole("figure", { name: "페르소나 전용 연결 예시" })).toBeTruthy();
  expect(screen.getByText(/당신이 궁금해진 페르소나가,/)).toBeTruthy();
  expect(screen.getByText(/당신을 더 알고 싶은 페르소나가 iMessage로 먼저 인사해요/)).toBeTruthy();
  expect(document.querySelectorAll(".home-connection-link svg")).toHaveLength(1);
  expect(document.querySelectorAll(".home-exclusive-image")).toHaveLength(1);
  expect(screen.getByRole("heading", { name: "다음 메시지가 기다려지는 사람." })).toBeTruthy();
});

test("home navigation, FAQs, title and the shared privacy notice follow the display language", () => {
  render(<Site />);
  selectLanguage("화면 언어", "English");
  expect(screen.getAllByRole("link", { name: "Meet the personas" })).toHaveLength(2);
  expect(screen.getByRole("navigation", { name: "About the service" })).toBeTruthy();
  const englishConversation = screen.getByRole("figure", {
    name: "An illustrative, fictional conversation",
  });
  expect(
    within(englishConversation).getByText("Snuck out for a break. The sunshine today ☀️"),
  ).toBeTruthy();
  expect(within(englishConversation).getAllByRole("listitem")).toHaveLength(9);
  expect(within(englishConversation).getAllByRole("list")).toHaveLength(1);
  expect(within(englishConversation).getAllByText("백도희")).toHaveLength(1);
  expect(within(englishConversation).getByText("Dohee loved my photo")).toBeTruthy();
  const music = within(englishConversation).getByRole("link", { name: /Best Part/ });
  expect(music.getAttribute("href")).toBe("https://open.spotify.com/track/1RMJOxR6GRPsBHL8qeC2ux");
  expect(music.getAttribute("target")).toBe("_blank");
  expect(screen.getByText("Am I talking to a real person?")).toBeTruthy();
  expect(screen.getByText(discoveryNotices.en.title)).toBeTruthy();
  expect(document.title).toBe("Ren AI — A little more to look forward to");
  expect(screen.getByRole("heading", { name: "A persona will reach out" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "A new person. Not another app." })).toBeTruthy();
  expect(screen.getByRole("heading", { name: /Only\s+you\s*\./ })).toBeTruthy();
  expect(
    screen.getByText("Your persona doesn't have conversations with anyone else."),
  ).toBeTruthy();
  expect(screen.getByText(/A persona who's curious about you/)).toBeTruthy();
  selectLanguage("Display language", "日本語");
  expect(screen.getAllByRole("link", { name: "ペルソナに出会う" })).toHaveLength(2);
  expect(screen.getByText("実在する人と話すのですか？")).toBeTruthy();
  expect(screen.getByText(discoveryNotices.ja.title)).toBeTruthy();
  expect(document.documentElement.lang).toBe("ja");
  expect(document.title).toBe("Ren AI — 日常に、待ち遠しいメッセージを");
  expect(screen.getByRole("heading", { name: "ペルソナから連絡します" })).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "新しいアプリより、 いつものメッセージで。" }),
  ).toBeTruthy();
  expect(screen.getByRole("heading", { name: /あなた\s*とだけ。/ })).toBeTruthy();
  expect(screen.getByText(/あなたのことが気になったペルソナが、/)).toBeTruthy();
  expect(
    within(screen.getByRole("figure", { name: "サービスを紹介する架空の会話例" })).getByText(
      "ちょっと休憩に来た。今日の日差し、気持ちいい ☀️",
    ),
  ).toBeTruthy();
});

test("landing starts in anime and changes every image together while retaining the selected persona", async () => {
  const profiles = vi.fn<DiscoveryClient["profiles"]>();
  const client = { profiles, join: vi.fn<DiscoveryClient["join"]>() };
  const first = render(<Site client={client} />);
  expect(document.querySelector(".conversation-photo img")?.getAttribute("src")).toBe(
    "/landing/dohee-daily-anime.webp",
  );
  fireEvent.click(screen.getByRole("button", { name: "강서율 프로필" }));
  await selectImageStyle("실사");
  expect(document.querySelector('.hero-scene[data-active="true"] img')?.getAttribute("src")).toBe(
    "/landing/seoyul.webp",
  );
  expect(document.querySelector(".conversation-photo img")?.getAttribute("src")).toBe(
    "/landing/dohee-daily.webp",
  );
  expect(document.querySelector(".conversation-contact img")?.getAttribute("src")).toBe(
    "/landing/dohee.webp",
  );
  expect(document.querySelector(".home-notification img")?.getAttribute("src")).toBe(
    "/icons/imessage.svg",
  );
  expect(document.querySelector(".home-exclusive-image")?.getAttribute("src")).toBe(
    "/landing/dohee-exclusive.webp",
  );
  expect(document.querySelector(".home-closing-photo > img")?.getAttribute("src")).toBe(
    "/landing/dohee-daily.webp",
  );
  await selectImageStyle("애니메");
  expect(screen.getByRole("button", { name: "강서율 프로필" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(document.querySelector(".conversation-contact img")?.getAttribute("src")).toBe(
    "/landing/dohee-anime.webp",
  );
  expect(document.querySelector(".home-exclusive-image")?.getAttribute("src")).toBe(
    "/landing/dohee-exclusive-anime.webp",
  );
  await selectImageStyle("실사");
  first.unmount();
  render(<Site client={client} />);
  expect(screen.getByRole("button", { name: "실사" }).getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector(".conversation-photo img")?.getAttribute("src")).toBe(
    "/landing/dohee-daily.webp",
  );
  expect(profiles).not.toHaveBeenCalled();
});

test("portrait selection changes the featured scene without leaving the page or losing it on locale changes", () => {
  const profiles = vi.fn<DiscoveryClient["profiles"]>();
  render(<Site client={{ profiles, join: vi.fn<DiscoveryClient["join"]>() }} />);
  const selected = screen.getByRole("button", { name: "백도희 프로필" });
  const next = screen.getByRole("button", { name: "강서율 프로필" });
  expect(selected.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(next);
  expect(selected.getAttribute("aria-pressed")).toBe("false");
  expect(next.getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector('.hero-scene[data-active="true"] img')?.getAttribute("src")).toBe(
    "/landing/seoyul-anime.webp",
  );
  selectLanguage("화면 언어", "English");
  expect(
    screen.getByRole("button", { name: "강서율 profile photo" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(window.location.pathname).toBe("/");
  expect(profiles).not.toHaveBeenCalled();
});

test("the menu toggles, closes after following a section and restores keyboard focus on Escape", () => {
  render(<Site />);
  const toggle = screen.getByRole("button", { name: "메뉴 열기 및 닫기" });
  const nav = screen.getByRole("navigation", { name: "서비스 소개 메뉴" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(within(nav).getByRole("link", { name: "Ren AI 소개" }));
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  fireEvent.keyDown(within(nav).getAllByRole("link")[0]!, { key: "Tab" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(within(nav).getAllByRole("link")[0]!, { key: "Escape" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(toggle);
});

test.each(["/explore", "/#reselect=private-token"])(
  "direct navigation to %s opens Discovery, preserves choices and keeps reselection fragments",
  async (url) => {
    window.history.replaceState(null, "", url);
    localStorage.setItem("ren-ai.discovery.image-style", "photo");
    localStorage.setItem("ren-ai.discovery.choices", JSON.stringify({ saved: true }));
    const client: DiscoveryClient = {
      profiles: async () => [
        { id: "saved", name: "소연", bio: "반가워요.", imageUrl: "/photo.jpg" },
      ],
      join: vi.fn<DiscoveryClient["join"]>(),
    };
    render(<Site client={client} />);
    await screen.findByRole("heading", { name: "오늘의 프로필을 모두 봤어요." });
    expect(screen.getByRole("list", { name: "좋아한 사람" }).textContent).toBe("소연");
    expect(screen.getByRole("link", { name: "Ren AI" }).getAttribute("href")).toBe("/");
    expect(document.title).toBe("Ren AI — 누가 궁금한가요?");
    expect(window.location.pathname + window.location.hash).toBe(url);
    cleanup();
    window.history.replaceState(null, "", "/");
    render(<Site client={client} />);
    expect(screen.getAllByRole("link", { name: "페르소나 만나보기" })).toHaveLength(2);
    expect(localStorage.getItem("ren-ai.discovery.choices")).toBe('{"saved":true}');
  },
);
