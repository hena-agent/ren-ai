import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { discoveryNotices } from "@ren-ai/onboarding";
import { afterEach, expect, test, vi } from "vitest";
import { JoinForm } from "./join-form.tsx";
import { RegistrationError, type DiscoveryClient } from "./client.ts";
import { LocaleProvider } from "./locale.tsx";
import type { Locale } from "./locale.tsx";
import { testClient } from "../test/client.ts";

afterEach(() => {
  cleanup();
  delete window.turnstile;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup(error: Error, locale: Locale = "ko", refresh?: () => Promise<void>) {
  let verify: (token: string) => void = vi.fn<(token: string) => void>();
  window.turnstile = {
    render: (_container, options) => {
      verify = options.callback;
      return "verification";
    },
    remove: () => {},
  };
  const join = vi
    .fn<DiscoveryClient["join"]>()
    .mockRejectedValueOnce(error)
    .mockResolvedValue({ status: "waiting" });
  const onBack = vi.fn<() => void>();
  const onSuccess = vi.fn<(status: "waiting" | "active") => void>();
  const profile = { id: "selected", name: "Selected", bio: "Public introduction", imageUrl: "" };
  render(
    <LocaleProvider initialLocale={locale}>
      <JoinForm
        imageStyle="anime"
        liked={[profile]}
        client={testClient({ join, profiles: async () => [profile] })}
        onBack={onBack}
        onSuccess={onSuccess}
        {...(refresh && { onRefresh: refresh })}
      />
    </LocaleProvider>,
  );
  const phone = screen.getByRole("textbox", {
    name: locale === "ko" ? "휴대전화 번호" : locale === "en" ? "Mobile number" : "携帯電話番号",
  });
  fireEvent.change(phone, { target: { value: "+821012345678" } });
  fireEvent.change(screen.getByRole("textbox", { name: /이름|Name|名前/ }), {
    target: { value: "Visitor" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  act(() => verify("verified"));
  const form = phone.closest("form")!;
  return { join, onBack, onSuccess, form, verify: () => act(() => verify("new-verification")) };
}

async function reviewSelection(form: HTMLFormElement) {
  await act(async () => fireEvent.submit(form));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "최신 목록에서 다시 선택" })),
  );
}

test.each(["ko", "en", "ja"] as const)(
  "errors explain the cause in %s without showing upstream payloads",
  async (locale) => {
    const messages = new Set<string>();
    for (const code of [
      "verification",
      "reselection",
      "storage",
      "unavailable",
      "personas",
      "ended_personas",
      "consent",
      "try_later",
      "registration",
    ] as const) {
      const requestId = crypto.randomUUID();
      const { form } = setup(new RegistrationError(code, requestId), locale);
      await act(async () => fireEvent.submit(form));
      expect(screen.getByRole("alert").textContent).toContain(requestId);
      messages.add(screen.getByRole("alert").querySelector("p")!.textContent);
      expect(screen.getByRole("alert").textContent).not.toMatch(
        /Registration unavailable|undefined/,
      );
      expect(screen.getByRole("alert").querySelector("button") !== null).toBe(
        ["personas", "ended_personas", "consent"].includes(code),
      );
      cleanup();
    }
    expect(messages.size).toBe(9);
  },
);

test("a rate limit shows its deadline, blocks repeat submissions and unlocks when it expires", async () => {
  vi.useFakeTimers();
  const deadline = Date.now() + 60_000;
  const { form, join, verify, onSuccess } = setup(
    new RegistrationError("try_later", undefined, deadline),
  );
  await act(async () => fireEvent.submit(form));
  expect(screen.getByRole("alert").querySelector("time")?.dateTime).toBe(
    new Date(deadline).toISOString(),
  );
  verify();
  await act(async () => fireEvent.submit(form));
  expect(join).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "동의하고 대기 등록" }).hasAttribute("disabled")).toBe(
    true,
  );
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(screen.getByRole("button", { name: "동의하고 대기 등록" }).hasAttribute("disabled")).toBe(
    false,
  );
  await act(async () => fireEvent.submit(form));
  expect(onSuccess).toHaveBeenCalledWith("waiting");
});

test("selection recovery refreshes the catalog before returning and retains typed profile input", async () => {
  const refresh = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("offline"));
  const { form, onBack, verify } = setup(new RegistrationError("personas"), "ko", refresh);
  const name = screen.getByLabelText<HTMLInputElement>("이름 (필수)");
  fireEvent.change(name, { target: { value: "입력한 이름" } });
  await reviewSelection(form);
  expect(refresh).toHaveBeenCalledOnce();
  expect(onBack).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("등록하지 못했어요");
  expect(name.value).toBe("입력한 이름");
  verify();
});

test("selection recovery returns to browsing after the refreshed list is ready", async () => {
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue();
  const { form, onBack } = setup(new RegistrationError("ended_personas"), "ko", refresh);
  await reviewSelection(form);
  expect(refresh).toHaveBeenCalledOnce();
  expect(onBack).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("an embedded contact form can return to its host's selection screen", async () => {
  const { form, onBack } = setup(new RegistrationError("ended_personas"));
  await reviewSelection(form);
  expect(onBack).toHaveBeenCalledOnce();
});

test("repeated recovery clicks share one pending refresh and a structured failure stays actionable", async () => {
  let reject: (cause: Error) => void = vi.fn<(cause: Error) => void>();
  const refresh = vi.fn<() => Promise<void>>().mockImplementation(
    () =>
      new Promise((_done, fail) => {
        reject = fail;
      }),
  );
  const { form, onBack } = setup(new RegistrationError("personas"), "ko", refresh);
  await act(async () => fireEvent.submit(form));
  const button = screen.getByRole("button", { name: "최신 목록에서 다시 선택" });
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(refresh).toHaveBeenCalledOnce();
  expect(onBack).not.toHaveBeenCalled();
  await act(async () => reject(new RegistrationError("storage", crypto.randomUUID())));
  expect(screen.getByRole("alert").textContent).toContain("지금은 등록을 처리할 수 없어요");
});

test("updated consent loads in place, preserves input and requires a fresh agreement", async () => {
  const updated = {
    ...discoveryNotices,
    ko: { ...discoveryNotices.ko, version: "updated-notice", consent: "새 안내에 동의합니다." },
  };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(updated)));
  const { form, join, verify } = setup(new RegistrationError("consent"));
  const name = screen.getByLabelText<HTMLInputElement>("이름 (필수)");
  fireEvent.change(name, { target: { value: "보존할 이름" } });
  await act(async () => fireEvent.submit(form));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "최신 안내 불러오기" })),
  );
  expect(name.value).toBe("보존할 이름");
  expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(false);
  expect(screen.getByText("updated-notice")).toBeTruthy();
  verify();
  await act(async () => fireEvent.submit(form));
  expect(join).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("checkbox", { name: "새 안내에 동의합니다." }));
  await act(async () => fireEvent.submit(form));
  expect(join).toHaveBeenLastCalledWith(
    expect.objectContaining({ name: "보존할 이름", privacyNoticeVersion: "updated-notice" }),
  );
});
