import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { discoveryNotice } from "@ren-ai/onboarding";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { JoinForm } from "./join-form.tsx";
import type { DiscoveryClient } from "./client.ts";

const liked = [
  {
    id: "ena",
    name: "에나",
    bio: "차를 마시며 얘기해요.",
    imageUrl: "https://example.net/ena.webp",
  },
];
let verification: ((token: string) => void) | undefined;
let failure: (() => void) | undefined;
let key: string | undefined;
const submit = vi.fn<DiscoveryClient["join"]>();
const back = vi.fn<() => void>();
const done = vi.fn<(state: "waiting" | "active") => void>();
const client: DiscoveryClient = { profiles: async () => liked, join: submit };

beforeEach(() => {
  vi.clearAllMocks();
  submit.mockReset();
  window.turnstile = {
    render: (_, options) => {
      key = options.sitekey;
      verification = options.callback;
      failure = options["error-callback"];
      return "widget";
    },
    remove: () => {},
  };
});
afterEach(() => {
  cleanup();
  delete window.turnstile;
  vi.unstubAllEnvs();
});

function mount(selected = liked) {
  return render(<JoinForm liked={selected} client={client} onBack={back} onSuccess={done} />);
}
function fill(handle = "Ena.User@EXAMPLE.NET") {
  fireEvent.change(screen.getByRole("textbox", { name: "전화번호 또는 Apple ID 이메일" }), {
    target: { value: handle },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: discoveryNotice.consent }));
  act(() => verification?.("passed"));
}

test("the form requires a valid handle, consent, verification and at least one Like", async () => {
  mount();
  const button = screen.getByRole("button", { name: "동의하고 대기 등록" });
  const form = button.closest("form")!;
  const handle = screen.getByRole("textbox", { name: "전화번호 또는 Apple ID 이메일" });
  expect(handle.getAttribute("value")).toBe("");
  expect(handle.getAttribute("aria-invalid")).toBe("false");
  expect(handle.getAttribute("aria-describedby")).toBe("handle-hint");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(key).toBe("1x00000000000000000000BB");
  fireEvent.submit(form);
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(handle, { target: { value: "bad" } });
  expect(screen.getByRole("alert").textContent).toBe(
    "전화번호 또는 Apple ID 이메일을 확인해 주세요.",
  );
  expect(handle.getAttribute("aria-invalid")).toBe("true");
  expect(handle.getAttribute("aria-describedby")).toBe("handle-error");
  fireEvent.submit(form);
  fireEvent.change(handle, { target: { value: "a@example.net" } });
  fireEvent.submit(form);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.submit(form);
  expect(submit).not.toHaveBeenCalled();
  act(() => failure?.());
  expect(screen.getByRole("alert").textContent).toBe(
    "사람 확인을 완료하지 못했어요. 다시 시도해 주세요.",
  );
  cleanup();
  mount([]);
  fill();
  fireEvent.submit(screen.getByRole("button", { name: "동의하고 대기 등록" }).closest("form")!);
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "동의하고 대기 등록" }).hasAttribute("disabled")).toBe(
    true,
  );
});

test("a pending registration cannot repeat, and failure retains the form for a fresh verification retry", async () => {
  let reject: (error: Error) => void = vi.fn<(error: Error) => void>();
  submit
    .mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValueOnce({ status: "active" });
  mount();
  fill();
  const form = screen.getByRole("button", { name: "동의하고 대기 등록" }).closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("textbox", { name: "전화번호 또는 Apple ID 이메일" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByRole("checkbox").hasAttribute("disabled")).toBe(true);
  expect(
    screen.getByRole("group", { name: "나에 대해 조금 더 (선택)" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByRole("button", { name: /탐색으로 돌아가기/ }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(screen.getByRole("status").textContent).toBe("관심을 전하고 있어요.");
  expect(screen.getByRole("status").classList.contains("sr-only")).toBe(true);
  expect(
    screen.getByRole("button", { name: "관심을 전하고 있어요." }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => reject(new Error("offline")));
  expect(screen.getByRole("alert").textContent).toBe(
    "등록하지 못했어요. 연락처와 선택을 확인하고 다시 시도해 주세요.",
  );
  expect(
    screen
      .getByRole("textbox", { name: "전화번호 또는 Apple ID 이메일" })
      .getAttribute("aria-invalid"),
  ).toBe("false");
  expect(screen.getByRole("button", { name: "동의하고 대기 등록" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(done).not.toHaveBeenCalled();
  act(() => verification?.("fresh"));
  fireEvent.submit(form);
  await act(async () => {});
  expect(done).toHaveBeenCalledWith("active");
  expect(submit).toHaveBeenLastCalledWith({
    handle: "ena.user@example.net",
    locale: "ko",
    conversationLanguage: "ko",
    privacyNoticeVersion: discoveryNotice.version,
    likedPersonaIDs: ["ena"],
    turnstileToken: "fresh",
  });
});

test("Korean phone normalization, AI disclosure and privacy contents are available before consent", () => {
  mount();
  expect(screen.getByText(discoveryNotice.aiNotice)).toBeTruthy();
  expect(screen.getByText("무엇을 보관하나요?")).toBeTruthy();
  expect(screen.getByText("중단과 삭제 요청")).toBeTruthy();
  expect(screen.getByText(discoveryNotice.sections[0]!.paragraphs[0]!)).toBeTruthy();
  const handle = screen.getByRole("textbox", { name: "전화번호 또는 Apple ID 이메일" });
  fireEvent.change(handle, { target: { value: "01055550123" } });
  expect(handle.getAttribute("aria-invalid")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: /탐색으로 돌아가기/ }));
  expect(back).toHaveBeenCalledTimes(1);
});

test("a public deployment uses its configured Turnstile key", () => {
  vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "public-invisible-key");
  mount();
  expect(key).toBe("public-invisible-key");
});

test("optional profile fields are independent, validated and retained through a failed submission", async () => {
  submit.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: "waiting" });
  mount();
  fill();
  const name = screen.getByLabelText<HTMLInputElement>("이름 (선택)");
  const age = screen.getByLabelText<HTMLInputElement>("만 나이 (선택)");
  const gender = screen.getByLabelText<HTMLSelectElement>("성별 (선택)");
  const form = name.form!;
  expect(name.required || age.required || gender.required).toBe(false);
  expect(gender.value).toBe("");
  for (const value of ["0", "-1", "1.5"]) {
    fireEvent.change(age, { target: { value } });
    fireEvent.submit(form);
  }
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(name, { target: { value: "  민수  " } });
  fireEvent.change(age, { target: { value: "28" } });
  fireEvent.change(gender, { target: { value: "other" } });
  await act(async () => fireEvent.submit(form));
  expect(submit.mock.calls[0]?.[0]).toMatchObject({ name: "민수", age: 28, gender: "other" });
  expect(name.value).toBe("  민수  ");
  expect(age.value).toBe("28");
  expect(gender.value).toBe("other");
  fireEvent.change(name, { target: { value: "  " } });
  fireEvent.change(gender, { target: { value: "" } });
  act(() => verification?.("fresh"));
  await act(async () => fireEvent.submit(form));
  expect(submit.mock.lastCall?.[0]).not.toHaveProperty("name");
  expect(submit.mock.lastCall?.[0]).not.toHaveProperty("gender");
  expect(submit.mock.lastCall?.[0].age).toBe(28);
});

test("verification alone cannot enable an invalid or unconsented submission, and native navigation is prevented", () => {
  mount();
  const button = screen.getByRole("button", { name: "동의하고 대기 등록" });
  const form = button.closest("form")!;
  act(() => verification?.("valid-token"));
  expect(button.hasAttribute("disabled")).toBe(true);
  const handle = screen.getByRole("textbox", { name: "전화번호 또는 Apple ID 이메일" });
  fireEvent.change(handle, { target: { value: "valid@example.net" } });
  expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(button.hasAttribute("disabled")).toBe(false);
  fireEvent.change(handle, { target: { value: "invalid" } });
  expect(button.hasAttribute("disabled")).toBe(true);
  const event = new Event("submit", { bubbles: true, cancelable: true });
  fireEvent(form, event);
  expect(event.defaultPrevented).toBe(true);
  expect(submit).not.toHaveBeenCalled();
});
