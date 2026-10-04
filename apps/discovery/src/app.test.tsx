import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { discoveryNotice } from "@ren-ai/onboarding";
import { App } from "./app.tsx";
import type { DiscoveryClient } from "./client.ts";
import { choose } from "../test/choose.ts";
beforeEach(() => localStorage.setItem("ren-ai.discovery.image-style", "photo"));

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.turnstile;
});

const people = [
  {
    id: "harin",
    name: "하린",
    bio: "밤 산책을 좋아해요.",
    imageUrl: "https://example.com/harin.jpg",
  },
  {
    id: "jiu",
    name: "지우",
    bio: "천천히 알아가고 싶어요.",
    imageUrl: "https://example.com/jiu.jpg",
  },
];

test("a visitor likes a profile, enters a handle and consent, and really joins the waitlist", async () => {
  const join = vi.fn<DiscoveryClient["join"]>().mockResolvedValue({ status: "waiting" });
  const client: DiscoveryClient = { profiles: async () => people, join };
  let verified: (token: string) => void = vi.fn<(token: string) => void>();
  window.turnstile = {
    render: (_, options) => {
      verified = options.callback;
      return "verified";
    },
    remove: () => {},
  };
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "하린" });
  expect(screen.getByRole("button", { name: /연락받기/ }).hasAttribute("disabled")).toBe(true);
  choose(true);
  await screen.findByRole("heading", { name: "지우" });
  fireEvent.click(screen.getByRole("button", { name: /연락받기/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "전화번호 또는 Apple ID 이메일" }), {
    target: { value: "010-1234-5678" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: discoveryNotice.consent }));
  act(() => verified("human"));
  fireEvent.click(screen.getByRole("button", { name: "동의하고 대기 등록" }));
  await screen.findByRole("heading", { name: "대기 등록이 완료됐어요." });
  expect(join).toHaveBeenCalledWith({
    handle: "+821012345678",
    locale: "ko",
    privacyNoticeVersion: discoveryNotice.version,
    likedPersonaIDs: ["harin"],
    turnstileToken: "human",
  });
  expect(screen.getByText("준비되는 대로, 좋아한 페르소나 중 한 명이 연락할 거예요.")).toBeTruthy();
  expect(
    screen.getByText(
      "등록 순서와 연락 시점은 정해져 있지 않아요. iMessage에서 첫 인사를 기다려 주세요.",
    ),
  ).toBeTruthy();
});

test("an existing user is directed to the assigned conversation instead of a new waiting promise", async () => {
  const client: DiscoveryClient = {
    profiles: async () => people,
    join: async () => ({ status: "active" }),
  };
  let verified: (token: string) => void = vi.fn<(token: string) => void>();
  window.turnstile = {
    render: (_, options) => {
      verified = options.callback;
      return "active-widget";
    },
    remove: () => {},
  };
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "하린" });
  choose(true);
  fireEvent.click(screen.getByRole("button", { name: /연락받기/ }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "existing@example.com" } });
  fireEvent.click(screen.getByRole("checkbox"));
  act(() => verified("active"));
  fireEvent.click(screen.getByRole("button", { name: "동의하고 대기 등록" }));
  await screen.findByRole("heading", { name: "이미 대화가 시작된 연락처예요." });
  expect(screen.getByText("iMessage에서 기존 페르소나와 대화를 이어가 주세요.")).toBeTruthy();
  expect(
    screen.queryByText(
      "등록 순서와 연락 시점은 정해져 있지 않아요. iMessage에서 첫 인사를 기다려 주세요.",
    ),
  ).toBeNull();
});
