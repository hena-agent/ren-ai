import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Card } from "./card.tsx";
import { endAnimation, resetCardTest, preferReducedMotion, swipeSurface } from "../test/choose.ts";

afterEach(resetCardTest);
const persona = { id: "mira", name: "미라", bio: "소개", imageUrl: "https://example.net/mira.jpg" };
const point = (x: number, y: number, pointerId = 1) => ({
  clientX: x,
  clientY: y,
  pointerId,
  isPrimary: true,
  button: 0,
});

function fixture() {
  const view = render(
    <Card
      persona={persona}
      onChoose={vi.fn<(like: boolean) => void>()}
      onOpen={vi.fn<(profile: typeof persona) => void>()}
    />,
  );
  const surface = swipeSurface();
  return { view, surface, article: surface.closest("article")! };
}

test("taps and small gestures never open a profile, including after returning to their origin", () => {
  for (const [x, y] of [
    [0, 0],
    [6, 0],
    [0, 6],
    [7, 0],
    [0, 7],
  ] as const) {
    const open = vi.fn<(profile: typeof persona) => void>();
    const view = render(
      <Card persona={persona} onChoose={vi.fn<(like: boolean) => void>()} onOpen={open} />,
    );
    const surface = swipeSurface();
    fireEvent.pointerDown(surface, point(100, 100));
    fireEvent.pointerMove(surface, point(100 + x, 100 + y));
    fireEvent.pointerMove(surface, point(100, 100));
    fireEvent.pointerUp(surface, point(100, 100));
    fireEvent.click(surface, { detail: 1 });
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(surface, { detail: 0 });
    expect(open).not.toHaveBeenCalled();
    view.unmount();
  }
});

test("release coordinates classify taps, diagonal drags and horizontal swipes independently of pointermove", () => {
  for (const [x, y, result] of [
    [0, 6, "tap"],
    [0, 7, "drag"],
    [90, 90, "drag"],
    [-90, 90, "drag"],
    [100, 0, "like"],
    [-100, 0, "pass"],
  ] as const) {
    const select = vi.fn<(like: boolean) => void>();
    const open = vi.fn<(profile: typeof persona) => void>();
    const view = render(<Card persona={persona} onChoose={select} onOpen={open} />);
    const surface = swipeSurface();
    fireEvent.pointerDown(surface, point(150, 200));
    fireEvent.pointerUp(surface, point(150 + x, 200 + y));
    expect(surface.closest("article")?.getAttribute("data-exit")).toBe(
      result === "like" || result === "pass" ? result : null,
    );
    fireEvent.click(surface, { detail: 1 });
    expect(open).not.toHaveBeenCalled();
    view.unmount();
  }
});

test.each([
  { button: 2, isPrimary: true },
  { button: 0, isPrimary: false },
])("non-primary input cannot start a swipe (%o)", (input) => {
  const { surface, article } = fixture();
  const capture = vi.fn<(id: number) => void>();
  surface.setPointerCapture = capture;
  fireEvent.pointerDown(surface, { ...point(100, 100), ...input });
  fireEvent.pointerMove(surface, point(220, 100));
  fireEvent.pointerUp(surface, point(220, 100));
  expect(capture).not.toHaveBeenCalled();
  expect(article.hasAttribute("data-exit")).toBe(false);
  expect(article.style.transform).toBe("translateX(0px) rotate(0deg)");
});

test("short drags and pointer cancellation restore position; foreign pointers never crash or change position", () => {
  const errors = vi.fn<(event: ErrorEvent) => void>();
  window.addEventListener("error", errors);
  try {
    const { surface, article } = fixture();
    fireEvent.pointerMove(surface, point(200, 200));
    fireEvent.pointerUp(surface, point(200, 200));
    fireEvent.pointerDown(surface, point(100, 100));
    fireEvent.pointerMove(surface, point(200, 100, 2));
    expect(article.style.transform).toBe("translateX(0px) rotate(0deg)");
    fireEvent.pointerMove(surface, point(110, 100));
    expect(article.getAttribute("data-dragging")).toBe("true");
    fireEvent.pointerUp(surface, point(110, 100));
    expect(article.style.transform).toBe("translateX(0px) rotate(0deg)");
    expect(article.getAttribute("data-dragging")).toBe("false");
    fireEvent.pointerDown(surface, point(100, 100));
    fireEvent.pointerMove(surface, point(110, 100));
    fireEvent.pointerCancel(surface);
    expect(article.style.transform).toBe("translateX(0px) rotate(0deg)");
    expect(errors).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("error", errors);
  }
});

test("button exits show their choice stamp and restore controls when complete", () => {
  const select = vi.fn<(like: boolean) => void>();
  const busy = vi.fn<(value: boolean) => void>();
  const view = render(
    <Card
      persona={persona}
      onChoose={select}
      onOpen={vi.fn<(profile: typeof persona) => void>()}
      onBusyChange={busy}
    />,
  );
  for (const [button, stamp, value] of [
    ["좋아요", "LIKE", true],
    ["넘기기", "PASS", false],
  ] as const) {
    fireEvent.click(screen.getByRole("button", { name: button }));
    expect(screen.getByText(stamp)).toBeTruthy();
    expect(busy).toHaveBeenLastCalledWith(true);
    endAnimation(document.querySelector("article")!);
    expect(select).toHaveBeenLastCalledWith(value);
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText(stamp)).toBeNull();
    expect(screen.getByRole("button", { name: button }).hasAttribute("disabled")).toBe(false);
  }
  const replacement = vi.fn<(value: boolean) => void>();
  busy.mockClear();
  view.rerender(
    <Card
      persona={persona}
      onChoose={select}
      onOpen={vi.fn<(profile: typeof persona) => void>()}
      onBusyChange={replacement}
    />,
  );
  expect(busy).toHaveBeenCalledExactlyOnceWith(false);
});

test("reduced motion also resets a pointer's dragged position before committing", () => {
  preferReducedMotion();
  const { surface } = fixture();
  fireEvent.pointerDown(surface, point(150, 200));
  fireEvent.pointerMove(surface, point(250, 200));
  fireEvent.pointerUp(surface, point(250, 200));
  expect(surface.closest("article")?.style.transform).toBe("translateX(0px) rotate(0deg)");
  expect(vi.getTimerCount()).toBe(0);
});
