import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { App } from "./app.tsx";
import { choose, endAnimation } from "../test/choose.ts";
import { fakeVerification } from "../test/turnstile.ts";

const people = ["하린", "지우"].map((name, index) => ({
  id: `inline-${index}`,
  name,
  bio: "친구가 찍어준 여행 사진과, 제가 직접 쓴 소개예요.",
  imageUrl: `https://example.net/${index}-main.jpg`,
  portraits: { photo: `https://example.net/${index}-main.jpg` },
  secondaryPortraits: [
    { style: "photo" as const, imageUrl: `https://example.net/${index}-extra.jpg` },
  ],
}));
const client = { profiles: async () => people, join: async () => ({ status: "waiting" as const }) };
const likedButton = (name: string) =>
  within(screen.getByRole("list", { name: "좋아요한 페르소나" })).getByRole("button", {
    name: `${name} 프로필 보기`,
  });
afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.turnstile;
});
async function browse() {
  fakeVerification();
  localStorage.setItem("ren-ai.discovery.image-style", "photo");
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "하린" });
}

test("expanded profiles keep the original card and shared choices, and selecting once advances the deck", async () => {
  await browse();
  const card = document.querySelector(".profile-card")!;
  const actions = document.querySelector(".swipe-actions")!;
  fireEvent.click(screen.getByRole("button", { name: "다음 사진" }));
  fireEvent.click(screen.getByRole("button", { name: "하린 소개 전체 보기" }));
  const profile = screen.getByRole("region", { name: "하린" });
  expect(profile.closest(".profile-card")).toBe(card);
  expect(document.querySelector(".swipe-actions")).toBe(actions);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(within(profile).getByRole("img").getAttribute("src")).toBe(
    people[0]!.secondaryPortraits[0]!.imageUrl,
  );
  const like = screen.getByRole("button", { name: "좋아요" });
  fireEvent.pointerDown(like);
  fireEvent.click(like);
  expect(screen.getByRole("region", { name: "하린" })).toBe(profile);
  expect(
    within(profile)
      .getAllByRole("button")
      .every((button) => button.hasAttribute("disabled")),
  ).toBe(true);
  fireEvent.keyDown(profile, { key: "Escape" });
  expect(screen.getByRole("region", { name: "하린" })).toBe(profile);
  fireEvent.click(like);
  endAnimation(card);
  expect(screen.queryByRole("region", { name: "하린" })).toBeNull();
  expect(screen.getByRole("heading", { name: "지우" })).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("ren-ai.discovery.choices")!)).toEqual({
    "inline-0": true,
  });
});

test("liked profiles use the same reading area and collapse back to the exact current photo", async () => {
  await browse();
  choose(true);
  fireEvent.click(screen.getByRole("button", { name: "다음 사진" }));
  const current = document.querySelector(".profile-card")!;
  const launch = likedButton("하린");
  launch.focus();
  fireEvent.click(launch);
  expect(screen.getByRole("region", { name: "하린" }).closest(".swipe-stage")).toBeTruthy();
  expect(current.closest(".deck")!.hasAttribute("hidden")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "프로필 접기" }));
  expect(document.querySelector(".profile-card")).toBe(current);
  expect(screen.getByRole("img", { name: "지우 프로필" }).getAttribute("src")).toBe(
    people[1]!.secondaryPortraits[0]!.imageUrl,
  );
  expect(document.activeElement).toBe(launch);
});

test("an exhausted deck can reopen a liked profile and Pass it, preserving the completed choices", async () => {
  await browse();
  choose(true);
  choose(false);
  fireEvent.click(likedButton("하린"));
  expect(screen.getByRole("region", { name: "하린" })).toBeTruthy();
  choose(false);
  expect(screen.getByText("아직 비어 있어요")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "하린" })).toBeNull();
  expect(JSON.parse(localStorage.getItem("ren-ai.discovery.choices")!)).toEqual({
    "inline-0": false,
    "inline-1": false,
  });
});

test("switching profiles in the sidebar cannot be undone by the previous profile's outside-click handler", async () => {
  await browse();
  choose(true);
  choose(true);
  fireEvent.click(likedButton("하린"));
  const next = likedButton("지우");
  fireEvent.pointerDown(next);
  fireEvent.click(next);
  expect(screen.getByRole("region", { name: "지우" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "하린" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "프로필 접기" }));
  expect(screen.queryByRole("region", { name: "지우" })).toBeNull();
});

test("leaving a reading profile for contact and returning resumes the compact browsing card", async () => {
  await browse();
  choose(true);
  fireEvent.click(screen.getByRole("button", { name: "지우 소개 전체 보기" }));
  fireEvent.click(screen.getByRole("button", { name: /연락받기/ }));
  expect(screen.getByRole("textbox")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "좋아요" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "탐색으로 돌아가기" }));
  expect(screen.queryByRole("region", { name: "지우" })).toBeNull();
  expect(screen.getByRole("button", { name: "지우 소개 전체 보기" })).toBeTruthy();
});

test("reading a liked profile during contact entry preserves the mounted form and typed handle", async () => {
  await browse();
  choose(true);
  fireEvent.click(screen.getByRole("button", { name: /연락받기/ }));
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "saved@example.com" } });
  fireEvent.click(likedButton("하린"));
  expect(screen.getByRole("region", { name: "하린" })).toBeTruthy();
  expect(input.closest(".contact-surface")!.hasAttribute("hidden")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "프로필 접기" }));
  expect(screen.getByRole("textbox")).toBe(input);
  expect(screen.queryByRole("button", { name: "좋아요" })).toBeNull();
  expect(input.getAttribute("value")).toBe("saved@example.com");
});
