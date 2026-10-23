import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { discoveryNotices } from "@ren-ai/onboarding";
import { App } from "./app.tsx";
import { LocalePicker, LocaleProvider } from "./locale.tsx";
import { LanguageSelect } from "./language-select.tsx";
import type { Locale } from "./locale.tsx";
import { ProfileLanguages } from "./profile-languages.tsx";
import type { DiscoveryClient } from "./client.ts";
import { choose, selectLanguage } from "../test/choose.ts";
import { JoinForm } from "./join-form.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete window.turnstile;
});
const persona = {
  id: "harin",
  name: "하린",
  bio: "제가 쓴 원문 그대로예요.",
  imageUrl: "https://example.org/harin.jpg",
  languages: {
    primary: "ko",
    native: ["ko"],
    proficiency: {
      ko: "fluent",
      en: "beginner",
      ja: "conversational",
      fr: "proficient",
      de: "fluent",
    },
  },
} as const;

function detectLocale() {
  const view = render(
    <LocaleProvider>
      <LocalePicker />
    </LocaleProvider>,
  );
  const label = screen.getByRole("combobox").textContent;
  const locales = { 한국어: "ko", English: "en", 日本語: "ja" };
  const locale = Object.entries(locales).find(([language]) => label?.includes(language))?.[1];
  view.unmount();
  return locale;
}

test("language detection prefers a saved choice, then supported browser languages, then English", () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-FR", "ja-JP"]);
  expect(detectLocale()).toBe("ja");
  localStorage.setItem("renai.locale", "en");
  expect(detectLocale()).toBe("en");
  localStorage.setItem("renai.locale", "unsupported");
  expect(detectLocale()).toBe("ja");
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
  });
  expect(detectLocale()).toBe("ja");
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-FR"]);
  expect(detectLocale()).toBe("en");
});

test("the globe picker exposes its selected language and opens a checked language list by keyboard", () => {
  render(
    <LocaleProvider>
      <LocalePicker />
    </LocaleProvider>,
  );
  const trigger = screen.getByRole("combobox", { name: "화면 언어" });
  expect(trigger.querySelector(".sr-only")?.textContent).toBe("한국어");
  expect(trigger.querySelector("svg circle")).not.toBeNull();
  fireEvent.keyDown(trigger, { key: "ArrowDown", code: "ArrowDown" });
  expect(screen.getByRole("option", { name: "한국어" }).textContent).toContain("✓");
  expect(screen.getAllByRole("option")).toHaveLength(3);
  fireEvent.click(screen.getByRole("option", { name: "English" }));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(trigger.querySelector(".sr-only")?.textContent).toBe("English");
  expect(trigger.getAttribute("aria-label")).toBe("Display language");
});

test("display changes preserve original profiles, photos, Likes and the mounted contact form, keeping conversation and consent languages distinct", async () => {
  localStorage.setItem("ren-ai.discovery.image-style", "photo");
  const join = vi.fn<DiscoveryClient["join"]>(async () => ({ status: "waiting" }));
  let verified: (token: string) => void = vi.fn<(token: string) => void>();
  window.turnstile = {
    render: (_element, options) => {
      verified = options.callback;
      return "language-widget";
    },
    remove: () => {},
  };
  const client: DiscoveryClient = { profiles: async () => [persona], join };
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "하린" });
  expect(screen.getByText(persona.bio)).toBeTruthy();
  const initialLanguages = screen.getByRole("region", { name: "사용하는 언어" });
  expect(within(initialLanguages).getAllByRole("listitem")).toHaveLength(2);
  choose(true);
  fireEvent.click(screen.getByRole("button", { name: "연락받기" }));
  fireEvent.change(screen.getByRole("textbox", { name: "휴대전화 번호" }), {
    target: { value: "01012345678" },
  });
  fireEvent.change(screen.getByLabelText("이름 (필수)"), { target: { value: "민수" } });
  fireEvent.change(screen.getByLabelText("만 나이 (선택)"), { target: { value: "28" } });
  fireEvent.change(screen.getByLabelText("성별 (선택)"), { target: { value: "male" } });
  fireEvent.click(screen.getByRole("checkbox"));
  selectLanguage("대화하고 싶은 언어", "日本語");
  fireEvent.click(screen.getByRole("radio", { name: /^친구/ }));
  selectLanguage("화면 언어", "English");
  expect(document.documentElement.lang).toBe("en");
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /^Friends/ }).checked).toBe(true);
  expect(localStorage.getItem("renai.locale")).toBe("en");
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Mobile number" }).value).toBe(
    "010-1234-5678",
  );
  expect(screen.getByLabelText<HTMLInputElement>("Name (required)").value).toBe("민수");
  expect(screen.getByLabelText<HTMLInputElement>("Age in years (optional)").value).toBe("28");
  expect(screen.getByLabelText<HTMLSelectElement>("Gender (optional)").value).toBe("male");
  const country = screen.getByRole<HTMLSelectElement>("combobox", { name: "Country code" });
  expect(country.value).toBe("KR");
  expect(within(country).getByRole("option", { name: "🇰🇷 South Korea +82" })).toBeTruthy();
  expect(
    screen.getByRole("combobox", { name: "Preferred conversation language" }).textContent,
  ).toContain("日本語");
  expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(false);
  expect(screen.getByText(discoveryNotices.en.aiNotice)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox"));
  selectLanguage("Display language", "日本語");
  expect(screen.getByText(discoveryNotices.ja.aiNotice)).toBeTruthy();
  expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(false);
  fireEvent.click(screen.getByRole("checkbox"));
  act(() => verified("human"));
  fireEvent.click(screen.getByRole("button", { name: "同意してウェイトリストに登録" }));
  await screen.findByRole("heading", { name: "ウェイトリストに登録しました。" });
  expect(join).toHaveBeenCalledWith({
    handle: "+821012345678",
    locale: "ja",
    conversationLanguage: "ja",
    startingRelationship: "friends",
    name: "민수",
    age: 28,
    gender: "male",
    privacyNoticeVersion: discoveryNotices.ja.version,
    turnstileToken: "human",
    likedPersonaIDs: ["harin"],
  });
});

test("localized proficiency includes all languages in details and keeps unset profiles unlabelled", () => {
  const view = render(<ProfileLanguages persona={persona} />);
  expect(screen.getAllByRole("listitem")).toHaveLength(5);
  expect(within(screen.getAllByRole("listitem")[0]!).getByText("한국어")).toBeTruthy();
  expect(
    within(screen.getAllByRole("listitem")[0]!).getByText("모국어 · 주 사용 언어"),
  ).toBeTruthy();
  expect(screen.getByText("프랑스어")).toBeTruthy();
  expect(screen.getByText("능숙")).toBeTruthy();
  view.rerender(
    <ProfileLanguages persona={{ ...persona, languages: { proficiency: { en: "fluent" } } }} />,
  );
  expect(screen.getByText("영어")).toBeTruthy();
  expect(screen.getByText("유창")).toBeTruthy();
  view.rerender(<ProfileLanguages persona={{ ...persona, languages: { proficiency: {} } }} />);
  expect(screen.queryByRole("region")).toBeNull();
  view.rerender(
    <ProfileLanguages persona={{ id: "unset", name: "Unset", bio: "Original", imageUrl: "" }} />,
  );
  expect(screen.queryByRole("region")).toBeNull();
});

test("blocked storage retains the chosen display language", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("blocked");
    },
  });
  const view = render(
    <LocaleProvider>
      <LocalePicker />
    </LocaleProvider>,
  );
  selectLanguage("화면 언어", "English");
  expect(document.documentElement.lang).toBe("en");
  expect(screen.getByRole("status").textContent).toContain("could not be saved");
  view.unmount();
  render(<LocalePicker />);
  expect(screen.getByRole("combobox", { name: "화면 언어" }).textContent).toContain("한국어");
  selectLanguage("화면 언어", "日本語");
  expect(screen.getByRole("combobox", { name: "화면 언어" }).textContent).toContain("한국어");
});

test("a disabled language control cannot open or change its value, and selection resumes when enabled", () => {
  const changeLanguage = vi.fn<(locale: Locale) => void>();
  const view = render(
    <LanguageSelect value="ko" label="Language" onValueChange={changeLanguage} disabled />,
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Language" }));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(changeLanguage).not.toHaveBeenCalled();
  view.rerender(<LanguageSelect value="ko" label="Language" onValueChange={changeLanguage} />);
  selectLanguage("Language", "English");
  expect(changeLanguage).toHaveBeenCalledWith("en");
});

test("conversation language choices are explicit and consent can be withdrawn", () => {
  render(
    <JoinForm
      liked={[persona]}
      client={{ profiles: async () => [persona], join: async () => ({ status: "waiting" }) }}
      onBack={vi.fn<() => void>()}
      onSuccess={vi.fn<(status: "waiting" | "active") => void>()}
    />,
  );
  selectLanguage("대화하고 싶은 언어", "English");
  expect(screen.getByRole("combobox", { name: "대화하고 싶은 언어" }).textContent).toContain(
    "English",
  );
  selectLanguage("대화하고 싶은 언어", "한국어");
  expect(screen.getByRole("combobox", { name: "대화하고 싶은 언어" }).textContent).toContain(
    "한국어",
  );
  const consent = screen.getByRole<HTMLInputElement>("checkbox");
  fireEvent.click(consent);
  expect(consent.checked).toBe(true);
  fireEvent.click(consent);
  expect(consent.checked).toBe(false);
});
