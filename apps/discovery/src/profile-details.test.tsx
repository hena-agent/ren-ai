import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ProfileDetails } from "./profile-details.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const persona = {
  id: "aria",
  name: "아리아",
  bio: "첫 소개",
  imageUrl: "https://example.net/aria.jpg",
};

test("updated modal content stays open and cleanup closes the native dialog and restores focus without scrolling", () => {
  const launcher = document.createElement("button");
  document.body.append(launcher);
  launcher.focus();
  const focus = vi.spyOn(launcher, "focus");
  try {
    const view = render(<ProfileDetails persona={persona} onClose={vi.fn<() => void>()} />);
    const dialog = screen.getByRole<HTMLDialogElement>("dialog", { name: "아리아" });
    const close = vi.spyOn(dialog, "close");
    view.rerender(
      <ProfileDetails persona={{ ...persona, bio: "바뀐 소개" }} onClose={vi.fn<() => void>()} />,
    );
    expect(screen.getByText("바뀐 소개")).toBeTruthy();
    expect(dialog.hasAttribute("open")).toBe(true);
    view.unmount();
    expect(close).toHaveBeenCalled();
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(launcher);
  } finally {
    launcher.remove();
  }
});

test("the dialog can open without a previously focused element and only traps Tab", () => {
  const view = render(<div />);
  const active = vi.spyOn(document, "activeElement", "get").mockReturnValue(null);
  const onClose = vi.fn<() => void>();
  view.rerender(<ProfileDetails persona={persona} onClose={onClose} />);
  active.mockRestore();
  const dialog = screen.getByRole("dialog");
  const button = screen.getByRole("button", { name: "프로필 닫기" });
  button.blur();
  const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
  fireEvent(dialog, down);
  expect(down.defaultPrevented).toBe(false);
  expect(document.activeElement).not.toBe(button);
  fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  expect(onClose).toHaveBeenCalledTimes(1);
  view.unmount();
});
