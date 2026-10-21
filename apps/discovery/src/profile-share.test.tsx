import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ProfileShare } from "./profile-share.tsx";
import { LocaleProvider } from "./locale.tsx";
import { publicPersonas } from "../test/public-personas.ts";
import { ProfileDetails } from "./profile-details.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("sharing uses the native share sheet with the chosen style and handles cancellation and retry", async () => {
  const share = vi
    .fn<Navigator["share"]>()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new DOMException("cancelled", "AbortError"))
    .mockRejectedValueOnce(new Error("offline"))
    .mockRejectedValueOnce("failed");
  vi.stubGlobal("navigator", { share });
  render(
    <LocaleProvider initialLocale="ko">
      <ProfileShare persona={publicPersonas[0]!} imageStyle="photo" />
    </LocaleProvider>,
  );
  const button = screen.getByRole("button", { name: "프로필 공유하기" });
  fireEvent.click(button);
  expect(button.hasAttribute("disabled")).toBe(true);
  await vi.waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  expect(share).toHaveBeenCalledWith({
    title: "백지아 — Ren AI",
    url: "https://renai.im/personas/jia?style=photo",
  });
  fireEvent.click(button);
  await vi.waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  expect(screen.getByRole("status").textContent).toBe("");
  for (let i = 0; i < 2; i++) {
    fireEvent.click(button);
    await screen.findByText("공유하지 못했어요. 다시 시도해 주세요.");
  }
});

test("without native sharing, copying restores the saved style and retains a retry after clipboard failure", async () => {
  const writeText = vi
    .fn<(text: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  localStorage.setItem("ren-ai.discovery.image-style", "photo");
  const view = render(
    <LocaleProvider initialLocale="ko">
      <ProfileShare persona={publicPersonas[0]!} />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "프로필 공유하기" }));
  await screen.findByText("공유하지 못했어요. 다시 시도해 주세요.");
  fireEvent.click(screen.getByRole("button", { name: "프로필 공유하기" }));
  await screen.findByText("링크를 복사했어요.");
  expect(writeText).toHaveBeenLastCalledWith("https://renai.im/personas/jia?style=photo");
  view.rerender(
    <LocaleProvider initialLocale="ko">
      <ProfileShare persona={publicPersonas[0]!} imageStyle="anime" />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "프로필 공유하기" }));
  await vi.waitFor(() =>
    expect(writeText).toHaveBeenLastCalledWith("https://renai.im/personas/jia?style=anime"),
  );
});

test("expanded profiles share their displayed style only from the final footer after all profile content", async () => {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(
    <LocaleProvider initialLocale="ko">
      <ProfileDetails
        persona={{ ...publicPersonas[0]!, imageStyle: "photo" }}
        image={0}
        onImageChange={vi.fn<(image: number) => void>()}
        onClose={vi.fn<() => void>()}
        disabled={false}
      />
    </LocaleProvider>,
  );
  expect(screen.queryByRole("link")).toBeNull();
  const button = screen.getByRole("button", { name: "프로필 공유하기" });
  const footer = button.closest(".details-footer")!;
  expect(document.querySelector(".details-scroll")!.lastElementChild).toBe(footer);
  expect(footer.previousElementSibling).toBe(document.querySelector(".details-content"));
  expect(document.querySelector(".details-toolbar .profile-share")).toBeNull();
  fireEvent.click(button);
  await screen.findByText("링크를 복사했어요.");
  expect(footer.querySelector("output")!.textContent).toBe("링크를 복사했어요.");
  expect(writeText).toHaveBeenCalledWith("https://renai.im/personas/jia?style=photo");
});
