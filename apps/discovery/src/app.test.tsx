import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { discoveryNotice } from "@ren-ai/onboarding";
import { App } from "./app.tsx";
import type { DiscoveryClient } from "./client.ts";
import { RegistrationError } from "./client.ts";
import { choose } from "../test/choose.ts";
import { testClient } from "../test/client.ts";
import { fakeVerification } from "../test/turnstile.ts";
beforeEach(() => localStorage.setItem("ren-ai.discovery.image-style", "photo"));

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.turnstile;
  window.history.replaceState(null, "", "/");
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

async function openContact() {
  await screen.findByRole("heading", { name: "하린" });
  choose(true);
  fireEvent.click(screen.getByRole("button", { name: /연락받기/ }));
}

test.each([undefined, "harin"])(
  "a stale selection reloads profiles without clearing the contact form (%s)",
  async (personaId) => {
    const join = vi
      .fn<DiscoveryClient["join"]>()
      .mockRejectedValueOnce(new RegistrationError("personas"))
      .mockResolvedValueOnce({ status: "waiting" });
    const profiles = vi
      .fn<DiscoveryClient["profiles"]>()
      .mockResolvedValueOnce(people)
      .mockResolvedValue(people.slice(1));
    let verified: (token: string) => void = vi.fn<(token: string) => void>();
    window.turnstile = {
      render: (_container, options) => {
        verified = options.callback;
        return "widget";
      },
      remove: () => {},
    };
    window.history.replaceState(null, "", personaId ? `/personas/${personaId}` : "/explore");
    render(<App client={testClient({ profiles, join })} {...(personaId && { personaId })} />);
    await openContact();
    fireEvent.change(screen.getByRole("textbox", { name: "휴대전화 번호" }), {
      target: { value: "01012345678" },
    });
    const name = screen.getByLabelText<HTMLInputElement>("이름 (필수)");
    fireEvent.change(name, { target: { value: "그대로 둘 이름" } });
    fireEvent.click(screen.getByRole("checkbox"));
    act(() => verified("verified"));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "동의하고 대기 등록" })),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "최신 목록에서 다시 선택" })),
    );
    expect(profiles).toHaveBeenCalledTimes(personaId ? 3 : 2);
    expect(window.location.pathname).toBe("/explore");
    expect(screen.getByRole("heading", { name: "지우" })).toBeTruthy();
    choose(true);
    fireEvent.click(screen.getByRole("button", { name: "연락받기" }));
    expect(screen.getByLabelText("이름 (필수)")).toBe(name);
    expect(name.value).toBe("그대로 둘 이름");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "휴대전화 번호" }).value).toBe(
      "010-1234-5678",
    );
    act(() => verified("fresh"));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "동의하고 대기 등록" })),
    );
    expect(join).toHaveBeenLastCalledWith(
      expect.objectContaining({ likedPersonaIDs: ["jiu"], name: "그대로 둘 이름" }),
    );
  },
);

test("a visitor likes a profile, enters a handle and consent, and really joins the waitlist", async () => {
  const join = vi.fn<DiscoveryClient["join"]>().mockResolvedValue({ status: "waiting" });
  const client = testClient({ profiles: async () => people, join });
  const verified = fakeVerification();
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "하린" });
  expect(screen.getByRole("button", { name: /연락받기/ }).hasAttribute("disabled")).toBe(true);
  choose(true);
  await screen.findByRole("heading", { name: "지우" });
  fireEvent.click(screen.getByRole("button", { name: /연락받기/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "휴대전화 번호" }), {
    target: { value: "010-1234-5678" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: discoveryNotice.consent }));
  fireEvent.change(screen.getByLabelText("이름 (필수)"), { target: { value: "민수" } });
  act(() => verified("human"));
  fireEvent.click(screen.getByRole("button", { name: "동의하고 대기 등록" }));
  await screen.findByRole("heading", { name: "대기 등록이 완료됐어요." });
  expect(join).toHaveBeenCalledWith({
    handle: "+821012345678",
    locale: "ko",
    conversationLanguage: "ko",
    startingRelationship: "dating",
    privacyNoticeVersion: discoveryNotice.version,
    likedPersonaIDs: ["harin"],
    turnstileToken: "human",
    name: "민수",
  });
  expect(screen.getByText("준비되는 대로, 좋아한 페르소나 중 한 명이 연락할 거예요.")).toBeTruthy();
  expect(
    screen.getByText(
      "등록 순서와 연락 시점은 정해져 있지 않아요. iMessage에서 Ren AI 안내는 noti@renai.im, 페르소나의 첫 인사는 hi@renai.im에서 와요.",
    ),
  ).toBeTruthy();
});

test("an existing user is directed to the assigned conversation instead of a new waiting promise", async () => {
  const client = testClient({
    profiles: async () => people,
    join: async () => ({ status: "active" }),
  });
  const verified = fakeVerification();
  render(<App client={client} />);
  await openContact();
  fireEvent.change(screen.getByRole("textbox", { name: "휴대전화 번호" }), {
    target: { value: "010-9876-5432" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  act(() => verified("active"));
  fireEvent.change(screen.getByLabelText("이름 (필수)"), { target: { value: "민수" } });
  fireEvent.click(screen.getByRole("button", { name: "동의하고 대기 등록" }));
  await screen.findByRole("heading", { name: "이미 대화가 시작된 연락처예요." });
  expect(screen.getByText("iMessage에서 기존 페르소나와 대화를 이어가 주세요.")).toBeTruthy();
  expect(
    screen.queryByText(
      "등록 순서와 연락 시점은 정해져 있지 않아요. iMessage에서 Ren AI 안내는 noti@renai.im, 페르소나의 첫 인사는 hi@renai.im에서 와요.",
    ),
  ).toBeNull();
});
