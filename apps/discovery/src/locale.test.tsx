import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { discoveryNotices } from "@ren-ai/onboarding";
import { App } from "./app.tsx";
import { LocalePicker, LocaleProvider } from "./locale.tsx";
import { ProfileLanguages } from "./profile-languages.tsx";
import type { DiscoveryClient } from "./client.ts";
import { choose } from "../test/choose.ts";

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
  const locale = screen.getByRole<HTMLSelectElement>("combobox").value;
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
  fireEvent.click(screen.getByRole("button", { name: /연락받기/ }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "language@example.org" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByRole("combobox", { name: "대화하고 싶은 언어" }), {
    target: { value: "ja" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "화면 언어" }), {
    target: { value: "en" },
  });
  expect(document.documentElement.lang).toBe("en");
  expect(localStorage.getItem("renai.locale")).toBe("en");
  expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe("language@example.org");
  expect(
    screen.getByRole<HTMLSelectElement>("combobox", { name: "Preferred conversation language" })
      .value,
  ).toBe("ja");
  expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(false);
  expect(screen.getByText(discoveryNotices.en.aiNotice)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByRole("combobox", { name: "Display language" }), {
    target: { value: "ja" },
  });
  expect(screen.getByText(discoveryNotices.ja.aiNotice)).toBeTruthy();
  expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(false);
  fireEvent.click(screen.getByRole("checkbox"));
  act(() => verified("human"));
  fireEvent.click(screen.getByRole("button", { name: "同意してウェイトリストに登録" }));
  await screen.findByRole("heading", { name: "ウェイトリストに登録しました。" });
  expect(join).toHaveBeenCalledWith({
    handle: "language@example.org",
    locale: "ja",
    conversationLanguage: "ja",
    privacyNoticeVersion: discoveryNotices.ja.version,
    turnstileToken: "human",
    likedPersonaIDs: ["harin"],
  });
});

test("localized proficiency includes all languages in details and keeps unset profiles unlabelled", () => {
  const view = render(<ProfileLanguages persona={persona} />);
  expect(screen.getAllByRole("listitem")).toHaveLength(5);
  expect(screen.getByText("한국어 · 모국어 · 주 사용 언어")).toBeTruthy();
  expect(screen.getByText("프랑스어 · 능숙")).toBeTruthy();
  view.rerender(
    <ProfileLanguages persona={{ ...persona, languages: { proficiency: { en: "fluent" } } }} />,
  );
  expect(screen.getByText("영어 · 유창")).toBeTruthy();
  view.rerender(<ProfileLanguages persona={{ ...persona, languages: { proficiency: {} } }} />);
  expect(screen.queryByRole("region")).toBeNull();
  view.rerender(
    <ProfileLanguages persona={{ id: "unset", name: "Unset", bio: "Original", imageUrl: "" }} />,
  );
  expect(screen.queryByRole("region")).toBeNull();
});

test("blocked storage retains the chosen language and invalid select events do not change it", () => {
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
  const select = screen.getByRole("combobox");
  fireEvent.change(select, { target: { value: "en" } });
  expect(document.documentElement.lang).toBe("en");
  expect(screen.getByRole("status").textContent).toContain("could not be saved");
  fireEvent.change(select, { target: { value: "invalid" } });
  expect(document.documentElement.lang).toBe("en");
  view.unmount();
  render(<LocalePicker />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "ja" } });
  expect(screen.getByRole<HTMLSelectElement>("combobox").value).toBe("ko");
});
