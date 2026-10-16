import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
const number = () => screen.getByRole<HTMLInputElement>("textbox", { name: "휴대전화 번호" });
const country = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "국가 번호" });
function fill(typed = "01012345678") {
  fireEvent.change(number(), { target: { value: typed } });
  fireEvent.click(screen.getByRole("checkbox", { name: discoveryNotice.consent }));
  act(() => verification?.("passed"));
}
const join = () =>
  fireEvent.submit(screen.getByRole("button", { name: "동의하고 대기 등록" }).closest("form")!);

test("the form requires a valid mobile number, consent, verification and at least one Like", async () => {
  mount();
  const button = screen.getByRole("button", { name: "동의하고 대기 등록" });
  const form = button.closest("form")!;
  expect(number().getAttribute("value")).toBe("");
  expect(number().getAttribute("aria-invalid")).toBe("false");
  expect(number().getAttribute("aria-describedby")).toBe("handle-hint");
  expect(
    screen.getByText(/iPhone 번호를 입력해 주세요\. Android는 아직 지원하지 않아요\./).id,
  ).toBe("handle-hint");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(key).toBe("1x00000000000000000000BB");
  fireEvent.submit(form);
  expect(submit).not.toHaveBeenCalled();
  for (const landline of ["02-123-4567", "070-1234-5678"]) {
    fireEvent.change(number(), { target: { value: landline } });
    fireEvent.blur(number());
    expect(screen.getByRole("alert").textContent).toBe("휴대전화 번호를 확인해 주세요.");
  }
  expect(number().getAttribute("aria-invalid")).toBe("true");
  expect(number().getAttribute("aria-describedby")).toBe("handle-error");
  fireEvent.submit(form);
  fireEvent.change(number(), { target: { value: "010-1234-5678" } });
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
  join();
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
  expect(number().hasAttribute("disabled")).toBe(true);
  expect(country().hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("checkbox").hasAttribute("disabled")).toBe(true);
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
  expect(number().getAttribute("aria-invalid")).toBe("false");
  expect(number().value).toBe("010-1234-5678");
  expect(screen.getByRole("button", { name: "동의하고 대기 등록" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(done).not.toHaveBeenCalled();
  act(() => verification?.("fresh"));
  fireEvent.submit(form);
  await act(async () => {});
  expect(done).toHaveBeenCalledWith("active");
  expect(submit).toHaveBeenLastCalledWith({
    handle: "+821012345678",
    locale: "ko",
    conversationLanguage: "ko",
    privacyNoticeVersion: discoveryNotice.version,
    likedPersonaIDs: ["ena"],
    turnstileToken: "fresh",
  });
});

test("AI disclosure and privacy contents are available before consent", () => {
  mount();
  expect(screen.getByText(discoveryNotice.aiNotice)).toBeTruthy();
  expect(screen.getByText("무엇을 보관하나요?")).toBeTruthy();
  expect(screen.getByText("중단과 삭제 요청")).toBeTruthy();
  expect(screen.getByText(discoveryNotice.sections[0]!.paragraphs[0]!)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /탐색으로 돌아가기/ }));
  expect(back).toHaveBeenCalledTimes(1);
});

test("an invalid number is pointed out only after leaving the field or trying to join", () => {
  mount();
  fireEvent.change(number(), { target: { value: "0101" } });
  expect(number().value).toBe("010-1");
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.blur(number());
  expect(screen.getByRole("alert").textContent).toBe("휴대전화 번호를 확인해 주세요.");
  fireEvent.change(number(), { target: { value: "01012" } });
  expect(screen.queryByRole("alert")).toBeNull();
  join();
  expect(screen.getByRole("alert").textContent).toBe("휴대전화 번호를 확인해 주세요.");
  fireEvent.change(number(), { target: { value: "" } });
  fireEvent.blur(number());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(submit).not.toHaveBeenCalled();
});

function detected() {
  const view = mount();
  const value = country().value;
  view.unmount();
  return value;
}

test("the country follows the device time zone, then the browser language, then Korea", () => {
  expect(detected()).toBe("KR");
  vi.stubEnv("TZ", "Asia/Tokyo");
  expect(detected()).toBe("JP");
  vi.stubEnv("TZ", "UTC");
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["es-419", "en-GB"]);
  expect(detected()).toBe("GB");
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["es-419"]);
  expect(detected()).toBe("KR");
  // Safari before 17 cannot list a region's time zones, so only the language remains.
  vi.stubEnv("TZ", "Asia/Tokyo");
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
  const locale = Reflect.getPrototypeOf(new Intl.Locale("en"))!;
  const timeZones = Reflect.getOwnPropertyDescriptor(locale, "getTimeZones")!;
  Reflect.deleteProperty(locale, "getTimeZones");
  try {
    expect(detected()).toBe("US");
  } finally {
    Reflect.defineProperty(locale, "getTimeZones", timeZones);
  }
});

test("the picker offers the detected country, Korea, Japan and the US before every other country", () => {
  vi.stubEnv("TZ", "Asia/Ho_Chi_Minh");
  mount();
  expect(country().value).toBe("VN");
  expect(screen.getByText("🇻🇳 +84").getAttribute("aria-hidden")).toBe("true");
  const options = within(country()).getAllByRole<HTMLOptionElement>("option");
  expect(options.slice(0, 6).map((option) => option.textContent)).toEqual([
    "🇻🇳 베트남 +84",
    "🇰🇷 대한민국 +82",
    "🇯🇵 일본 +81",
    "🇺🇸 미국 +1",
    "──────────",
    "🇬🇭 가나 +233",
  ]);
  expect(options[4]!.disabled).toBe(true);
  expect(options).toHaveLength(246);
});

test("a pasted international number chooses its country and joins in international form", async () => {
  submit.mockResolvedValueOnce({ status: "waiting" });
  mount();
  fill("+1 415 555 0100");
  expect(country().value).toBe("US");
  expect(screen.getByText("🇺🇸 +1")).toBeTruthy();
  join();
  await act(async () => {});
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ handle: "+14155550100" }));
});

test("choosing another country reads the typed digits as that country's number", () => {
  mount();
  expect(number().getAttribute("placeholder")).toBe("010-2000-0000");
  fireEvent.change(number(), { target: { value: "09012345678" } });
  fireEvent.blur(number());
  expect(screen.getByRole("alert").textContent).toBe("휴대전화 번호를 확인해 주세요.");
  fireEvent.change(country(), { target: { value: "JP" } });
  expect(number().value).toBe("090-1234-5678");
  expect(number().getAttribute("placeholder")).toBe("090-1234-5678");
  expect(screen.getByText("🇯🇵 +81")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.change(country(), { target: { value: "──────────" } });
  expect(country().value).toBe("JP");
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
  fireEvent.change(number(), { target: { value: "010-9876-5432" } });
  expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(button.hasAttribute("disabled")).toBe(false);
  fireEvent.change(number(), { target: { value: "010-9876" } });
  expect(button.hasAttribute("disabled")).toBe(true);
  const event = new Event("submit", { bubbles: true, cancelable: true });
  fireEvent(form, event);
  expect(event.defaultPrevented).toBe(true);
  expect(submit).not.toHaveBeenCalled();
});
