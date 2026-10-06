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

const fields = { image: 0, onImageChange: vi.fn<(image: number) => void>(), disabled: false };

test("photo, text and outside clicks never collapse a profile; only its arrow does", () => {
  const onClose = vi.fn<() => void>();
  render(
    <>
      <button>배경</button>
      <ProfileDetails {...fields} persona={persona} onClose={onClose} />
    </>,
  );
  const panel = screen.getByRole("region", { name: persona.name });
  const outside = screen.getByRole("button", { name: "배경" });
  const photo = screen.getByRole("img");
  fireEvent.click(outside);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.pointerDown(photo);
  fireEvent.click(photo);
  fireEvent.click(screen.getByText(persona.bio));
  fireEvent.pointerDown(photo);
  fireEvent.click(outside);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.pointerDown(outside);
  fireEvent.click(photo);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.pointerDown(outside);
  fireEvent.click(outside);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(outside);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "프로필 접기" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(panel.closest("dialog")).toBeNull();
});

test("updated inline content stays in place and collapsing restores its launcher without scrolling", () => {
  const launcher = document.createElement("button");
  document.body.append(launcher);
  launcher.focus();
  const focus = vi.spyOn(launcher, "focus");
  const initialFocus = vi.spyOn(HTMLElement.prototype, "focus");
  try {
    const onClose = vi.fn<() => void>();
    const view = render(<ProfileDetails {...fields} persona={persona} onClose={onClose} />);
    const panel = screen.getByRole("region", { name: "아리아" });
    expect(initialFocus).toHaveBeenCalledWith({ preventScroll: true });
    view.rerender(
      <ProfileDetails {...fields} persona={{ ...persona, bio: "바뀐 소개" }} onClose={onClose} />,
    );
    expect(screen.getByText("바뀐 소개")).toBeTruthy();
    expect(screen.getByRole("region")).toBe(panel);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "프로필 접기" }));
    view.unmount();
    fireEvent.pointerDown(panel);
    fireEvent.click(panel);
    expect(view.container.childElementCount).toBe(0);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(launcher);
  } finally {
    launcher.remove();
  }
});

test("unmounted profiles release their Escape listener", () => {
  const onClose = vi.fn<() => void>();
  const view = render(<ProfileDetails {...fields} persona={persona} onClose={onClose} />);
  const remove = vi.spyOn(document, "removeEventListener");
  view.rerender(
    <ProfileDetails
      {...fields}
      persona={{ ...persona, id: "other", name: "새 인물" }}
      onClose={onClose}
    />,
  );
  expect(screen.getByRole("region", { name: "새 인물" })).toBeTruthy();
  fireEvent.pointerDown(document.body);
  view.unmount();
  expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));
  fireEvent.click(document.body);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.pointerDown(document.body);
  fireEvent.click(document.body);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
});

test("inline reading permits native keyboard scrolling and normal Tab navigation", () => {
  render(<ProfileDetails {...fields} persona={persona} onClose={vi.fn<() => void>()} />);
  const panel = screen.getByRole("region");
  const close = screen.getByRole("button", { name: "프로필 접기" });
  close.focus();
  const scroll = new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true });
  fireEvent(close, scroll);
  expect(scroll.defaultPrevented).toBe(false);
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  fireEvent(panel, tab);
  expect(tab.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(close);
});

test("a profile can open without previous focus and Escape or its arrow collapses it", () => {
  const view = render(<div />);
  const active = vi.spyOn(document, "activeElement", "get").mockReturnValue(null);
  const onClose = vi.fn<() => void>();
  view.rerender(<ProfileDetails {...fields} persona={persona} onClose={onClose} />);
  active.mockRestore();
  const panel = screen.getByRole("region");
  const button = screen.getByRole("button", { name: "프로필 접기" });
  button.blur();
  const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
  fireEvent(panel, down);
  expect(down.defaultPrevented).toBe(false);
  expect(document.activeElement).not.toBe(button);
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  fireEvent(panel, escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(button);
  expect(onClose).toHaveBeenCalledTimes(2);
  view.unmount();
});
