import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { discoveryNotice } from "@ren-ai/onboarding";
import { App } from "./app.tsx";
import type { DiscoveryClient } from "./client.ts";
import { choose, endAnimation } from "../test/choose.ts";
import { fakeVerification } from "../test/turnstile.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.turnstile;
});
const people = ["하린", "지우"].map((name, index) => ({
  id: `person${index}`,
  name,
  bio: "첫째 줄의 소개입니다.\n둘째 줄도 모두 읽을 수 있어요.",
  imageUrl: `https://example.net/${index}.jpg`,
}));
const client: DiscoveryClient = {
  profiles: async () => people,
  join: async () => ({ status: "waiting" }),
};
const currentTabs = () =>
  within(screen.getByRole("navigation", { name: "페르소나 탐색 메뉴" }))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-current"));

test("the app navigation exposes liked profiles and full details without turning taps into Likes", async () => {
  localStorage.setItem("ren-ai.discovery.image-style", "photo");
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "하린" });
  expect(screen.getByText("아직 비어 있어요")).toBeTruthy();
  const surface = screen.getByRole("button", { name: "하린 프로필 보기" });
  expect(document.activeElement).toBe(surface);
  expect(currentTabs()).toEqual(["page", null, null]);
  fireEvent.click(surface);
  const dialog = screen.getByRole("dialog", { name: "하린" });
  expect(dialog.hasAttribute("open")).toBe(true);
  expect(within(dialog).getByRole("img", { name: "하린 프로필" }).getAttribute("src")).toBe(
    people[0]!.imageUrl,
  );
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  fireEvent(dialog, tab);
  expect(tab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "프로필 닫기" }));
  within(dialog).getByRole("button", { name: "프로필 닫기" }).blur();
  fireEvent.keyDown(dialog, { key: "ArrowDown" });
  expect(document.activeElement).not.toBe(
    within(dialog).getByRole("button", { name: "프로필 닫기" }),
  );
  expect(dialog.querySelector(".details-content p")?.textContent).toBe(people[0]!.bio);
  expect(localStorage.getItem("ren-ai.discovery.choices")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "프로필 닫기" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(surface);
  const navigation = screen.getByRole("navigation", { name: "페르소나 탐색 메뉴" });
  fireEvent.click(screen.getByRole("button", { name: "좋아요" }));
  for (const button of within(navigation).getAllByRole("button"))
    expect(button.hasAttribute("disabled")).toBe(true);
  endAnimation(document.querySelector(".profile-card")!);
  for (const button of within(navigation).getAllByRole("button"))
    expect(button.hasAttribute("disabled")).toBe(false);
  const liked = screen.getByRole("list", { name: "좋아요한 페르소나" });
  expect(liked.textContent).toBe("하린");
  fireEvent.click(within(navigation).getByRole("button", { name: "좋아요한 페르소나 1" }));
  expect(document.querySelector(".app-workspace")?.getAttribute("data-view")).toBe("liked");
  expect(currentTabs()).toEqual([null, "page", null]);
  expect(
    within(navigation)
      .getByRole("button", { name: "좋아요한 페르소나 1" })
      .getAttribute("aria-current"),
  ).toBe("page");
  fireEvent.click(within(liked).getByRole("button", { name: "하린 프로필 보기" }));
  const cancel = new Event("cancel", { cancelable: true });
  fireEvent(screen.getByRole("dialog"), cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(JSON.parse(localStorage.getItem("ren-ai.discovery.choices")!)).toEqual({ person0: true });
  fireEvent.click(within(navigation).getByRole("button", { name: "탐색" }));
  expect(document.querySelector(".app-workspace")?.getAttribute("data-view")).toBe("browse");
  expect(currentTabs()).toEqual(["page", null, null]);
  fireEvent.click(screen.getByRole("button", { name: "지우 소개 전체 보기" }));
  expect(screen.getByRole("dialog", { name: "지우" })).toBeTruthy();
});

test("pending registration disables navigation until a recoverable failure completes", async () => {
  localStorage.setItem("ren-ai.discovery.image-style", "photo");
  const verify = fakeVerification();
  let reject: (error: Error) => void = vi.fn<(error: Error) => void>();
  const join: DiscoveryClient["join"] = () =>
    new Promise((_, fail) => {
      reject = fail;
    });
  render(<App client={{ ...client, join }} />);
  await screen.findByRole("heading", { name: "하린" });
  choose(true);
  const navigation = screen.getByRole("navigation", { name: "페르소나 탐색 메뉴" });
  fireEvent.click(within(navigation).getByRole("button", { name: /연락받기/ }));
  expect(
    within(navigation)
      .getByRole("button", { name: /연락받기/ })
      .getAttribute("aria-current"),
  ).toBe("page");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "person@example.com" } });
  expect(currentTabs()).toEqual([null, null, "page"]);
  fireEvent.click(screen.getByRole("checkbox", { name: discoveryNotice.consent }));
  act(() => verify("human"));
  fireEvent.click(screen.getByRole("button", { name: "동의하고 대기 등록" }));
  for (const button of within(navigation).getAllByRole("button"))
    expect(button.hasAttribute("disabled")).toBe(true);
  await act(async () => reject(new Error("offline")));
  expect(screen.getByRole("alert").textContent).toContain("등록하지 못했어요.");
  for (const button of within(navigation).getAllByRole("button"))
    expect(button.hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("textbox").getAttribute("value")).toBe("person@example.com");
});
