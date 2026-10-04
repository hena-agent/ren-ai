import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Card } from "./card.tsx";
import { endAnimation, resetCardTest, preferReducedMotion } from "../test/choose.ts";

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
  const surface = screen.getByRole("button", { name: "미라 프로필 보기" });
  return { view, surface, article: surface.closest("article")! };
}

test("a moved gesture remains a drag after returning to its origin; six-pixel taps stay taps", () => {
  for (const [x, y, opens] of [
    [0, 0, true],
    [6, 0, true],
    [0, 6, true],
    [7, 0, false],
    [0, 7, false],
  ] as const) {
    const open = vi.fn<(profile: typeof persona) => void>();
    const view = render(
      <Card persona={persona} onChoose={vi.fn<(like: boolean) => void>()} onOpen={open} />,
    );
    const surface = screen.getByRole("button", { name: "미라 프로필 보기" });
    fireEvent.pointerDown(surface, point(100, 100));
    fireEvent.pointerMove(surface, point(100 + x, 100 + y));
    fireEvent.pointerMove(surface, point(100, 100));
    fireEvent.pointerUp(surface, point(100, 100));
    fireEvent.click(surface, { detail: 1 });
    expect(open).toHaveBeenCalledTimes(opens ? 1 : 0);
    fireEvent.click(surface, { detail: 0 });
    expect(open).toHaveBeenCalledTimes(opens ? 2 : 1);
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
    const surface = screen.getByRole("button", { name: "미라 프로필 보기" });
    fireEvent.pointerDown(surface, point(150, 200));
    fireEvent.pointerUp(surface, point(150 + x, 200 + y));
    expect(surface.closest("article")?.getAttribute("data-exit")).toBe(
      result === "like" || result === "pass" ? result : null,
    );
    fireEvent.click(surface, { detail: 1 });
    expect(open).toHaveBeenCalledTimes(result === "tap" ? 1 : 0);
    view.unmount();
  }
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
