import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { LocalePicker, LocaleProvider } from "./locale.tsx";
import { useSeo } from "./use-seo.ts";
import { pageSeo } from "./seo.ts";
import { publicPersonas } from "../test/public-personas.ts";
import { selectDropdown } from "../test/choose.ts";
import { Site } from "./site.tsx";
import { testClient } from "../test/client.ts";
import type { DiscoveryClient } from "./client.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  document.head
    .querySelectorAll('meta[name], meta[property], link, script[type="application/ld+json"]')
    .forEach((node) => node.remove());
});

function Preview({ profile = false, missing = false, photo = false }) {
  useSeo(
    missing ? "/personas/missing" : "/about",
    profile ? publicPersonas[0] : undefined,
    photo ? "photo" : "anime",
  );
  return <LocalePicker />;
}

test("explicit URL language overrides storage and device language; switching keeps the route, query, fragment and localized metadata", () => {
  localStorage.setItem("renai.locale", "ko");
  window.history.replaceState(null, "", "/en/about?utm_source=friend#about");
  const view = render(
    <LocaleProvider>
      <Preview />
    </LocaleProvider>,
  );
  expect(document.documentElement.lang).toBe("en");
  expect(document.title).toBe(pageSeo(new URL("https://renai.im/en/about")).title);
  expect(document.head.querySelector('meta[property="og:image"]')?.getAttribute("content")).toBe(
    "https://renai.im/social-en-v3.png",
  );
  expect(document.head.querySelectorAll("link[hreflang]")).toHaveLength(4);
  selectDropdown("Display language", "日本語");
  expect(window.location.pathname + window.location.search + window.location.hash).toBe(
    "/ja/about?utm_source=friend#about",
  );
  expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
    "https://renai.im/ja/about",
  );
  expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
  expect(document.head.querySelectorAll('meta[property="og:locale:alternate"]')).toHaveLength(2);
  view.rerender(
    <LocaleProvider>
      <Preview profile photo />
    </LocaleProvider>,
  );
  expect(document.title).toContain("RenAIのAIペルソナ");
  expect(
    document.head.querySelector('meta[property="og:image:alt"]')?.getAttribute("content"),
  ).toContain("フォト");
  expect(document.head.querySelector('meta[property="og:url"]')?.getAttribute("content")).toBe(
    "https://renai.im/ja/personas/jia?style=photo&preview=v3",
  );
  expect(document.head.querySelector('script[type="application/ld+json"]')?.textContent).toContain(
    "Fictional AI persona",
  );
  view.rerender(
    <LocaleProvider>
      <Preview missing />
    </LocaleProvider>,
  );
  expect(document.head.querySelectorAll("link[hreflang]")).toHaveLength(0);
  expect(document.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
    "noindex,follow",
  );
});

test("localized direct exploration and profile navigation preserve the current locale and refresh metadata", async () => {
  window.history.replaceState(null, "", "/explore#invite=PRIVATE");
  const profiles = vi.fn<DiscoveryClient["profiles"]>(async () => publicPersonas);
  render(<Site client={testClient({ profiles, join: async () => ({ status: "waiting" }) })} />);
  await screen.findByRole("heading", { name: "백지아, 26" });
  expect(screen.getByRole("link", { name: "RenAI" }).getAttribute("href")).toBe("/explore");
  fireEvent.click(screen.getByRole("button", { name: "백지아 View full profile" }));
  expect(window.location.pathname).toBe("/personas/jia");
  expect(window.location.hash).toBe("#invite=PRIVATE");
  expect(document.title).toContain("An AI persona on RenAI");
  expect(
    document.head.querySelector('meta[property="og:url"]')?.getAttribute("content"),
  ).not.toContain("PRIVATE");
  selectDropdown("Display language", "日本語");
  expect(window.location.pathname).toBe("/ja/personas/jia");
  expect(
    document.head.querySelector('meta[property="og:image:alt"]')?.getAttribute("content"),
  ).toContain("アニメ");
  fireEvent.click(screen.getByRole("button", { name: "プロフィールを閉じる" }));
  expect(window.location.pathname).toBe("/ja/explore");
  expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
    "https://renai.im/ja/explore",
  );
});
