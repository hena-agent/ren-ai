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
  expect(screen.getByRole("textbox").getAttribute("value")).toBe("");
  expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("false");
  expect(screen.getByRole("textbox").getAttribute("aria-describedby")).toBe("handle-hint");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(key).toBe("1x00000000000000000000BB");
  fireEvent.submit(form);
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "bad" } });
  expect(screen.getByRole("alert").textContent).toBe(
    "전화번호 또는 Apple ID 이메일을 확인해 주세요.",
  );
  expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByRole("textbox").getAttribute("aria-describedby")).toBe("handle-error");
  fireEvent.submit(form);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "a@example.net" } });
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
  expect(screen.getByRole("textbox").hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("checkbox").hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: /탐색으로 돌아가기/ }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(screen.getByRole("status").textContent).toBe("관심을 전하고 있어요.");
  expect(
    screen.getByRole("button", { name: "관심을 전하고 있어요." }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => reject(new Error("offline")));
  expect(screen.getByRole("alert").textContent).toBe(
    "등록하지 못했어요. 연락처와 선택을 확인하고 다시 시도해 주세요.",
  );
  expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("false");
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
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "01055550123" } });
  expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: /탐색으로 돌아가기/ }));
  expect(back).toHaveBeenCalledTimes(1);
});

test("a public deployment uses its configured Turnstile key", () => {
  vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "public-invisible-key");
  mount();
  expect(key).toBe("public-invisible-key");
});

test("verification alone cannot enable an invalid or unconsented submission, and native navigation is prevented", () => {
  mount();
  const button = screen.getByRole("button", { name: "동의하고 대기 등록" });
  const form = button.closest("form")!;
  act(() => verification?.("valid-token"));
  expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "valid@example.net" } });
  expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(button.hasAttribute("disabled")).toBe(false);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "invalid" } });
  expect(button.hasAttribute("disabled")).toBe(true);
  const event = new Event("submit", { bubbles: true, cancelable: true });
  fireEvent(form, event);
  expect(event.defaultPrevented).toBe(true);
  expect(submit).not.toHaveBeenCalled();
});
