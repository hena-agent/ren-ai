import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Site } from "./site.tsx";
import { App } from "./app.tsx";
import { testClient } from "../test/client.ts";
import { publicPersonas } from "../test/public-personas.ts";
import { messages } from "./locale.tsx";
import { choose, dismissGuide } from "../test/choose.ts";

const client = testClient({
  profiles: async () => publicPersonas,
  join: async () => ({ status: "waiting" }),
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

test.each(["/explore#invite=secret", "/personas/jia?style=photo", "/ko/explore", "/ja/explore"])(
  "first entry at %s explains the flow, keeps the entry intact and remembers dismissal",
  async (path) => {
    window.history.replaceState(null, "", path);
    const view = render(<Site client={client} />);
    const dialog = await screen.findByRole("dialog");
    const locale = path.startsWith("/ko") ? "ko" : path.startsWith("/ja") ? "ja" : "en";
    const copy = messages[locale].guide;
    expect(within(dialog).getByRole("heading").textContent).toBe(copy.title);
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
    expect(within(dialog).getByText(copy.requirement)).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: copy.about }).getAttribute("href")).toBe(
      `${locale === "en" ? "" : `/${locale}`}/about`,
    );
    expect(within(dialog).getByRole("link", { name: copy.privacy }).getAttribute("href")).toContain(
      "/about#privacy",
    );
    fireEvent.click(within(dialog).getByRole("heading"));
    expect(screen.getByRole("dialog")).toBe(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: copy.start }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(localStorage.getItem("ren-ai.discovery.guide-seen")).toBe("1");
    expect(window.location.hash).toBe(path.includes("#") ? "#invite=secret" : "");
    expect(window.location.pathname).toBe(path.split(/[?#]/)[0]);
    view.unmount();
    render(<Site client={client} />);
    await screen.findByRole("button", { name: copy.open });
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

test("reopening, all dismissal methods and in-dialog locale changes preserve browsing and private fragments", async () => {
  window.history.replaceState(null, "", "/ko/explore#invite=secret");
  render(<Site client={client} />);
  const dialog = await screen.findByRole("dialog");
  fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "ArrowDown" });
  fireEvent.click(within(dialog).getByRole("option", { name: "English" }));
  expect(within(dialog).getByRole("heading").textContent).toBe(messages.en.guide.title);
  expect(localStorage.getItem("ren-ai.discovery.guide-seen")).toBeNull();
  expect(window.location.pathname + window.location.hash).toBe("/explore#invite=secret");
  fireEvent.click(within(dialog).getByRole("button", { name: "Close guide" }));
  const trigger = screen.getByRole("button", { name: "About RenAI" });
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(dialog);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  for (const link of within(dialog).getAllByRole("link")) {
    localStorage.removeItem("ren-ai.discovery.guide-seen");
    fireEvent.click(link);
    expect(localStorage.getItem("ren-ai.discovery.guide-seen")).toBe("1");
  }
});

test.each(["liked", "passed", "reselection", "seen"])(
  "%s visitors skip automatic opening but can read the guide",
  async (kind) => {
    if (kind === "liked" || kind === "passed")
      localStorage.setItem("ren-ai.discovery.choices", JSON.stringify({ jia: kind === "liked" }));
    if (kind === "seen") localStorage.setItem("ren-ai.discovery.guide-seen", "1");
    render(
      <App client={client} reselectionToken={kind === "reselection" ? "private" : undefined} />,
    );
    const trigger = await screen.findByRole("button", { name: messages.ko.guide.open });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();
  },
);

test("blocked storage does not prevent dismissal or reopen on locale changes", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  render(<App client={client} />);
  await screen.findByRole("dialog");
  dismissGuide();
  expect(screen.queryByRole("dialog")).toBeNull();
  choose(true);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: messages.ko.guide.open }));
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("loading, failure, missing profiles and an empty Catalog never open the guide", async () => {
  const profiles = vi.fn<typeof client.profiles>().mockRejectedValue(new Error("offline"));
  const view = render(<App client={testClient({ profiles, join: client.join })} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  await screen.findByText("프로필을 불러오지 못했어요.");
  expect(screen.queryByRole("dialog")).toBeNull();
  view.unmount();
  const empty = render(
    <App client={testClient({ profiles: async () => [], join: client.join })} initialPeople={[]} />,
  );
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
  empty.unmount();
  render(<App client={client} initialPeople={publicPersonas} personaId="missing" />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test.each(["/missing", "/ko/missing"])(
  "the browser cannot render About as a fallback at %s",
  (path) => {
    window.history.replaceState(null, "", path);
    render(<Site client={client} />);
    expect(screen.getByRole("heading").textContent).toBe("404 — RenAI");
    expect(screen.getByRole("link").getAttribute("href")).toContain("/explore");
  },
);

test("Escape in the guide preserves the shared profile, including a language-menu Escape", async () => {
  window.history.replaceState(null, "", "/ko/personas/jia?style=photo#invite=secret");
  render(<Site client={client} />);
  const dialog = await screen.findByRole("dialog");
  const profile = screen.getByRole("region", { name: /백지아/ });
  fireEvent.keyDown(within(dialog).getByRole("button", { name: messages.ko.guide.start }), {
    key: "Escape",
  });
  expect(window.location.pathname).toBe("/ko/personas/jia");
  expect(screen.getByRole("region", { name: /백지아/ })).toBe(profile);
  fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
  const consumed = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  consumed.preventDefault();
  fireEvent(document, consumed);
  expect(screen.getByRole("region", { name: /백지아/ })).toBe(profile);
  expect(window.location.hash).toBe("#invite=secret");
});

test("dismissal is persisted synchronously even if the browser defers its native close event", async () => {
  render(<App client={client} />);
  const dialog = await screen.findByRole<HTMLDialogElement>("dialog");
  vi.spyOn(dialog, "close").mockImplementation(() => dialog.removeAttribute("open"));
  dismissGuide();
  expect(localStorage.getItem("ren-ai.discovery.guide-seen")).toBe("1");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: messages.ko.guide.open }));
});

test("changing guide language preserves an opened profile and photo when the new sample excludes it", async () => {
  const browse = vi.fn<typeof client.browse>().mockImplementation(async ({ locale }) => ({
    people: locale === "ko" ? [publicPersonas[0]!] : [publicPersonas[1]!],
    nextCursor: null,
  }));
  render(<App client={{ ...client, browse }} />);
  await screen.findByRole("dialog");
  dismissGuide();
  fireEvent.click(screen.getByRole("button", { name: "다음 사진" }));
  fireEvent.click(screen.getByRole("button", { name: "백지아 소개 전체 보기" }));
  const profile = screen.getByRole("region", { name: /백지아/ });
  const photo = within(profile).getByRole("img").getAttribute("src");
  fireEvent.click(screen.getByRole("button", { name: messages.ko.guide.open }));
  const dialog = screen.getByRole("dialog");
  fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "ArrowDown" });
  fireEvent.click(within(dialog).getByRole("option", { name: "English" }));
  await act(async () => {});
  expect(browse.mock.lastCall?.[0]).toEqual({ locale: "en" });
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(screen.getByRole("region", { name: /백지아/ })).toBe(profile);
  expect(within(profile).getByRole("img").getAttribute("src")).toBe(photo);
  dismissGuide();
  fireEvent.click(screen.getByRole("button", { name: "Collapse profile" }));
  expect(document.querySelector(".profile-photo")?.getAttribute("src")).toBe(photo);
});
