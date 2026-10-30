import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { discoveryNotices } from "@ren-ai/onboarding";
import { Site } from "./site.tsx";
import type { DiscoveryClient } from "./client.ts";
import { selectImageStyle, selectDropdown } from "../test/choose.ts";
import { testClient } from "../test/client.ts";

beforeEach(() => window.history.replaceState(null, "", "/ko"));

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.getElementById("public-personas")?.remove();
  vi.restoreAllMocks();
});

test("the home explains the service without loading profiles and offers real navigation to Discovery", () => {
  const profiles = vi.fn<DiscoveryClient["profiles"]>().mockRejectedValue(new Error("offline"));
  render(<Site client={testClient({ profiles, join: vi.fn<DiscoveryClient["join"]>() })} />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "일상에,기다려지는 메시지 하나.",
  );
  expect(profiles).not.toHaveBeenCalled();
  expect(document.querySelector(".discovery-shell")).toBeNull();
  for (const link of screen.getAllByRole("link", { name: "페르소나 만나보기" })) {
    expect(link.getAttribute("href")).toBe("/ko/explore");
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
  expect(document.title).toBe("RenAI — 일상에, 기다려지는 메시지 하나");
  expect(screen.getByRole("heading", { name: "페르소나가 연락할 거예요" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "새 앱 말고, 늘 쓰던 메시지에서." })).toBeTruthy();
  expect(screen.getByText("새 앱 설치 없이, 익숙한 iMessage에서.")).toBeTruthy();
  expect(screen.getByText(/당신을 더 알고 싶은 페르소나가 iMessage로 먼저 인사해요/)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "다음 메시지가 기다려지는 사람." })).toBeTruthy();
});

test("home navigation, FAQs, title and the shared privacy notice follow the display language", () => {
  render(<Site />);
  selectDropdown("화면 언어", "English");
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
  expect(within(englishConversation).getAllByText("Jia")).toHaveLength(1);
  expect(screen.getAllByText("Jia")).toHaveLength(4);
  for (const name of ["Subin", "Jia", "Harin"]) {
    expect(screen.getByRole("button", { name: `${name} profile photo` })).toBeTruthy();
  }
  expect(within(englishConversation).getByText("Jia loved my photo")).toBeTruthy();
  const music = within(englishConversation).getByRole("link", { name: /Best Part/ });
  expect(music.getAttribute("href")).toBe("https://open.spotify.com/track/1RMJOxR6GRPsBHL8qeC2ux");
  expect(music.getAttribute("target")).toBe("_blank");
  expect(screen.getByText("Am I talking to a real person?")).toBeTruthy();
  expect(screen.getByText(discoveryNotices.en.title)).toBeTruthy();
  expect(document.title).toBe("RenAI — A little more to look forward to");
  expect(screen.getByRole("heading", { name: "A persona will reach out" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "A new person. Not another app." })).toBeTruthy();
  expect(screen.getByText("No new app. Just iMessage.", { selector: ".home-intro" })).toBeTruthy();
  selectDropdown("Display language", "日本語");
  expect(screen.getAllByRole("link", { name: "ペルソナに出会う" })).toHaveLength(2);
  expect(screen.getByText("実在する人と話すのですか？")).toBeTruthy();
  expect(screen.getByText(discoveryNotices.ja.title)).toBeTruthy();
  expect(document.documentElement.lang).toBe("ja");
  expect(screen.getAllByText("ジア")).toHaveLength(4);
  for (const name of ["スビン", "ジア", "ハリン"]) {
    expect(screen.getByRole("button", { name: `${name} プロフィール写真` })).toBeTruthy();
  }
  expect(document.title).toBe("RenAI — 日常に、待ち遠しいメッセージを");
  expect(screen.getByRole("heading", { name: "ペルソナから連絡します" })).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "新しいアプリより、 いつものメッセージで。" }),
  ).toBeTruthy();
  expect(screen.getByText("新しいアプリなしで、いつものiMessageから。")).toBeTruthy();
  expect(
    within(screen.getByRole("figure", { name: "サービスを紹介する架空の会話例" })).getByText(
      "ちょっと休憩に来た。今日の日差し、気持ちいい ☀️",
    ),
  ).toBeTruthy();
});

test("landing switches immediately during slow image loading and retains the selected persona", async () => {
  vi.spyOn(HTMLImageElement.prototype, "decode").mockReturnValue(new Promise(() => {}));
  const profiles = vi.fn<DiscoveryClient["profiles"]>();
  const client = testClient({ profiles, join: vi.fn<DiscoveryClient["join"]>() });
  const first = render(<Site client={client} />);
  expect(document.querySelector(".conversation-photo img")?.getAttribute("src")).toBe(
    "/landing/dohee-daily-anime.webp",
  );
  fireEvent.click(screen.getByRole("button", { name: "강하린 프로필" }));
  fireEvent.click(screen.getByRole("button", { name: "실사" }));
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
  expect(document.querySelector(".home-closing-photo > img")?.getAttribute("src")).toBe(
    "/landing/dohee-daily.webp",
  );
  await selectImageStyle("애니메");
  expect(screen.getByRole("button", { name: "강하린 프로필" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(document.querySelector(".conversation-contact img")?.getAttribute("src")).toBe(
    "/landing/dohee-anime.webp",
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
  render(<Site client={testClient({ profiles, join: vi.fn<DiscoveryClient["join"]>() })} />);
  const selected = screen.getByRole("button", { name: "백지아 프로필" });
  const next = screen.getByRole("button", { name: "강하린 프로필" });
  expect(selected.getAttribute("aria-pressed")).toBe("true");
  expect(
    [...document.querySelectorAll(".hero-scene img")].map((image) =>
      image.getAttribute("fetchpriority"),
    ),
  ).toEqual(["low", "high", "low"]);
  fireEvent.click(next);
  expect(selected.getAttribute("aria-pressed")).toBe("false");
  expect(next.getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector('.hero-scene[data-active="true"] img')?.getAttribute("src")).toBe(
    "/landing/seoyul-anime.webp",
  );
  selectDropdown("화면 언어", "English");
  expect(
    screen.getByRole("button", { name: "Harin profile photo" }).getAttribute("aria-pressed"),
  ).toBe("true");
  selectDropdown("Display language", "日本語");
  expect(
    screen.getByRole("button", { name: "ハリン プロフィール写真" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(document.querySelector('.hero-scene[data-active="true"] img')?.getAttribute("src")).toBe(
    "/landing/seoyul-anime.webp",
  );
  expect(window.location.pathname).toBe("/ja");
  expect(profiles).not.toHaveBeenCalled();
});

test("the menu toggles, closes after following a section and restores keyboard focus on Escape", () => {
  render(<Site />);
  const toggle = screen.getByRole("button", { name: "메뉴 열기 및 닫기" });
  const nav = screen.getByRole("navigation", { name: "서비스 소개 메뉴" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(within(nav).getByRole("link", { name: "RenAI 소개" }));
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  fireEvent.keyDown(within(nav).getAllByRole("link")[0]!, { key: "Tab" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(within(nav).getAllByRole("link")[0]!, { key: "Escape" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(toggle);
});

test.each(["/ko/explore", "/ko#reselect=private-token"])(
  "direct navigation to %s opens Discovery, preserves choices and keeps reselection fragments",
  async (url) => {
    window.history.replaceState(null, "", url);
    localStorage.setItem("ren-ai.discovery.image-style", "photo");
    localStorage.setItem("ren-ai.discovery.choices", JSON.stringify({ saved: true }));
    const client = testClient({
      profiles: async () => [
        { id: "saved", name: "소연", bio: "반가워요.", imageUrl: "/photo.jpg" },
      ],
      join: vi.fn<DiscoveryClient["join"]>(),
    });
    render(<Site client={client} />);
    await screen.findByRole("heading", { name: "오늘의 프로필을 모두 봤어요." });
    expect(screen.getByRole("list", { name: "좋아한 사람" }).textContent).toBe("소연");
    expect(screen.getByRole("link", { name: "RenAI" }).getAttribute("href")).toBe("/ko");
    expect(document.title).toBe("RenAI — 누가 궁금한가요?");
    expect(window.location.pathname + window.location.hash).toBe(url);
    cleanup();
    window.history.replaceState(null, "", "/ko");
    render(<Site client={client} />);
    expect(screen.getAllByRole("link", { name: "페르소나 만나보기" })).toHaveLength(2);
    expect(localStorage.getItem("ren-ai.discovery.choices")).toBe('{"saved":true}');
  },
);

test("explore starts from its server-sampled page and display rendition without loading or resampling", async () => {
  window.history.replaceState(null, "", "/ko/explore");
  const script = document.createElement("script");
  script.id = "public-personas";
  script.type = "application/json";
  script.textContent = JSON.stringify({
    people: [
      {
        id: "jia",
        name: "백지아",
        bio: "반가워요.",
        imageUrl: "https://persona-images.renai.im/00000000-0000-0000-0000-000000000009.png",
      },
    ],
    page: { locale: "ko", nextCursor: null },
  });
  document.body.append(script);
  const browse = vi.fn<DiscoveryClient["browse"]>();
  const profiles = vi.fn<DiscoveryClient["profiles"]>();
  render(
    <Site
      client={{ ...testClient({ profiles, join: vi.fn<DiscoveryClient["join"]>() }), browse }}
    />,
  );
  expect(screen.getByRole("heading", { name: "백지아" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "백지아 프로필" }).getAttribute("src")).toBe(
    "https://persona-images.renai.im/thumbnails/00000000-0000-0000-0000-000000000009.jpg",
  );
  expect(screen.queryByText("만날 사람들을 불러오고 있어요.")).toBeNull();
  await act(async () => {});
  expect(browse).not.toHaveBeenCalled();
  expect(profiles).not.toHaveBeenCalled();
});

test("explore displays its shell during a delayed API request and retries a failed listing once", async () => {
  window.history.replaceState(null, "", "/ko/explore");
  let rejectListing: (cause: Error) => void = vi.fn<(cause: Error) => void>();
  const listing = new Promise<Awaited<ReturnType<DiscoveryClient["profiles"]>>>((_, reject) => {
    rejectListing = reject;
  });
  const profiles = vi
    .fn<DiscoveryClient["profiles"]>()
    .mockReturnValueOnce(listing)
    .mockResolvedValueOnce([
      { id: "jia", name: "백지아", bio: "반가워요.", imageUrl: "/photo.jpg" },
    ]);
  render(<Site client={testClient({ profiles, join: vi.fn<DiscoveryClient["join"]>() })} />);
  expect(screen.getByRole("link", { name: "RenAI" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("만날 사람들을 불러오고 있어요.");
  await act(async () => {});
  expect(profiles).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), undefined, []);
  expect(document.querySelector(".profile-card")).toBeNull();
  await act(async () => rejectListing(new Error("API unavailable")));
  expect(screen.getByRole("heading", { name: "프로필을 불러오지 못했어요." })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
  expect(await screen.findByRole("heading", { name: "백지아" })).toBeTruthy();
  expect(profiles).toHaveBeenCalledTimes(2);
});

test("the English root uses unprefixed links and remembers an explicit English choice when switching back", () => {
  window.history.replaceState(null, "", "/?utm_source=friend#about");
  localStorage.setItem("renai.locale", "ko");
  const view = render(<Site />);
  expect(document.documentElement.lang).toBe("en");
  expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
    "https://renai.im/",
  );
  for (const link of screen.getAllByRole("link", { name: "Meet the personas" }))
    expect(link.getAttribute("href")).toBe("/explore");
  selectDropdown("Display language", "日本語");
  selectDropdown("表示言語", "English");
  expect(window.location.pathname + window.location.search + window.location.hash).toBe(
    "/?utm_source=friend#about",
  );
  expect(document.cookie).toContain("renai.locale=en");
  view.unmount();
  render(<Site />);
  expect(document.documentElement.lang).toBe("en");
});
