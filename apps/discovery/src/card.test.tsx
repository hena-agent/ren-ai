import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Card } from "./card.tsx";
import { endAnimation, resetCardTest, preferReducedMotion, swipeSurface } from "../test/choose.ts";

afterEach(resetCardTest);
const profile = {
  id: "yerin",
  name: "예린",
  bio: "필름 사진을 찍어요.",
  imageUrl: "https://example.org/yerin.png",
};
const point = (x: number, pointerId = 1, y = 0) => ({
  clientX: x,
  clientY: y,
  pointerId,
  isPrimary: true,
  button: 0,
});

test("a swipe commits exactly one choice and only the up-arrow opens details", () => {
  const select = vi.fn<(like: boolean) => void>();
  const open = vi.fn<(persona: typeof profile) => void>();
  const busy = vi.fn<(value: boolean) => void>();
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  render(
    <Card
      persona={profile}
      onChoose={select}
      onOpen={open}
      onBusyChange={busy}
      next={{ ...profile, id: "next" }}
    />,
  );
  const surface = swipeSurface();
  const article = surface.closest("article")!;
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(article.getAttribute("data-dragging")).toBe("false");
  expect(article.getAttribute("aria-busy")).toBe("false");
  expect(document.querySelector(".card-back img")?.getAttribute("src")).toBe(profile.imageUrl);
  expect(document.querySelector(".card-back img")?.getAttribute("draggable")).toBe("false");
  expect(screen.getByRole("img").getAttribute("draggable")).toBe("false");
  fireEvent.click(surface, { detail: 1 });
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "예린 소개 전체 보기" }));
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith(profile);
  fireEvent.pointerDown(surface, point(100));
  fireEvent.pointerMove(surface, point(160));
  expect(article.style.transform).toBe("translateX(60px) rotate(2.5deg)");
  expect(article.getAttribute("data-dragging")).toBe("true");
  expect(screen.getByText("LIKE")).toBeTruthy();
  fireEvent.pointerUp(surface, point(190));
  expect(article.getAttribute("data-exit")).toBe("like");
  expect(article.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByRole("button", { name: "좋아요" }).hasAttribute("disabled")).toBe(true);
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(surface);
  fireEvent.click(screen.getByRole("button", { name: "예린 소개 전체 보기" }));
  expect(open).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByRole("button", { name: "예린 소개 전체 보기" }), {
    key: "ArrowLeft",
  });
  endAnimation(article, "card-enter");
  endAnimation(screen.getByRole("img"));
  expect(select).not.toHaveBeenCalled();
  endAnimation(article);
  expect(select).toHaveBeenCalledExactlyOnceWith(true);
  endAnimation(article);
  expect(select).toHaveBeenCalledTimes(1);
  expect(busy).toHaveBeenLastCalledWith(false);
  expect(article.hasAttribute("data-exit")).toBe(false);
  expect(article.getAttribute("aria-busy")).toBe("false");
  expect(screen.getByRole("button", { name: "좋아요" }).hasAttribute("disabled")).toBe(false);
  fireEvent.pointerDown(surface, point(200));
  fireEvent.pointerMove(surface, point(150));
  expect(screen.getByText("PASS")).toBeTruthy();
  fireEvent.pointerUp(surface, point(110));
  endAnimation(article);
  expect(select).toHaveBeenLastCalledWith(false);
});

test("small, vertical or cancelled drags do not become a choice or an accidental profile tap", () => {
  const select = vi.fn<(like: boolean) => void>();
  const open = vi.fn<(persona: typeof profile) => void>();
  render(<Card persona={profile} onChoose={select} onOpen={open} />);
  const surface = swipeSurface();
  const capture = vi.fn<(id: number) => void>();
  surface.setPointerCapture = capture;
  fireEvent.pointerMove(surface, point(80));
  fireEvent.pointerUp(surface, point(80));
  fireEvent.pointerDown(surface, { ...point(50), button: 2 });
  fireEvent.pointerUp(surface, point(200));
  fireEvent.pointerDown(surface, { ...point(50), isPrimary: false });
  fireEvent.pointerUp(surface, point(200));
  fireEvent.pointerDown(surface, point(50));
  expect(capture).toHaveBeenCalledWith(1);
  fireEvent.pointerMove(surface, point(200, 2));
  fireEvent.pointerUp(surface, point(200, 2));
  fireEvent.pointerUp(surface, point(139));
  fireEvent.click(surface, { detail: 1 });
  expect(open).not.toHaveBeenCalled();
  expect(surface.closest("article")?.style.transform).toBe("translateX(0px) rotate(0deg)");
  fireEvent.pointerDown(surface, point(0));
  fireEvent.pointerUp(surface, point(100, 1, 120));
  fireEvent.pointerDown(surface, point(200));
  fireEvent.pointerUp(surface, point(100, 1, 120));
  fireEvent.pointerDown(surface, point(100));
  fireEvent.pointerMove(surface, point(110));
  fireEvent.pointerCancel(surface);
  fireEvent.pointerUp(surface, point(250));
  fireEvent.click(surface, { detail: 1 });
  fireEvent.keyDown(screen.getByRole("button", { name: "예린 소개 전체 보기" }), { key: "Home" });
  expect(surface.closest("article")!.hasAttribute("data-exit")).toBe(false);
  expect(select).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  fireEvent.pointerDown(surface, point(100));
  fireEvent.pointerUp(surface, point(106));
  fireEvent.click(surface, { detail: 1 });
  expect(open).not.toHaveBeenCalled();
  fireEvent.pointerDown(surface, point(100));
  fireEvent.pointerMove(surface, point(100, 1, 7));
  fireEvent.pointerMove(surface, point(100));
  fireEvent.pointerUp(surface, point(100));
  fireEvent.click(surface, { detail: 1 });
  expect(open).not.toHaveBeenCalled();
});

test("buttons and keyboard share exit animations, a fallback finishes interrupted animation, and unmount cancels it", () => {
  vi.useFakeTimers();
  const select = vi.fn<(like: boolean) => void>();
  const view = render(
    <Card
      persona={profile}
      onChoose={select}
      onOpen={vi.fn<(persona: typeof profile) => void>()}
    />,
  );
  const surface = screen.getByRole("button", { name: "예린 소개 전체 보기" });
  const event = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
  fireEvent(surface, event);
  expect(event.defaultPrevented).toBe(true);
  expect(surface.closest("article")?.getAttribute("data-exit")).toBe("pass");
  act(() => {
    vi.advanceTimersByTime(399);
  });
  expect(select).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(select).toHaveBeenCalledExactlyOnceWith(false);
  fireEvent.keyDown(surface, { key: "ArrowRight" });
  endAnimation(surface.closest("article")!);
  expect(select).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "넘기기" }));
  view.unmount();
  act(() => {
    vi.runAllTimers();
  });
  expect(select).toHaveBeenCalledTimes(2);
});

test("reduced motion commits immediately without an exit timer", () => {
  preferReducedMotion();
  const select = vi.fn<(like: boolean) => void>();
  render(
    <Card
      persona={profile}
      onChoose={select}
      onOpen={vi.fn<(persona: typeof profile) => void>()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "좋아요" }));
  expect(select).toHaveBeenCalledExactlyOnceWith(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(document.querySelector("article")?.hasAttribute("data-exit")).toBe(false);
});

test("drag stamps use strict boundaries and image style changes retry a failed portrait", () => {
  const select = vi.fn<(like: boolean) => void>();
  const open = vi.fn<(persona: typeof profile) => void>();
  const view = render(<Card persona={profile} onChoose={select} onOpen={open} />);
  const surface = swipeSurface();
  fireEvent.pointerDown(surface, point(100));
  fireEvent.pointerMove(surface, point(124));
  expect(screen.queryByText("LIKE")).toBeNull();
  fireEvent.pointerMove(surface, point(125));
  expect(screen.getByText("LIKE")).toBeTruthy();
  fireEvent.pointerMove(surface, point(76));
  expect(screen.queryByText("PASS")).toBeNull();
  fireEvent.pointerMove(surface, point(75));
  expect(screen.getByText("PASS")).toBeTruthy();
  fireEvent.error(screen.getByRole("img"));
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("예")).toBeTruthy();
  expect(screen.getByText("사진을 불러오지 못했어요.")).toBeTruthy();
  view.rerender(
    <Card
      persona={{ ...profile, imageUrl: "https://example.org/anime.png" }}
      onChoose={select}
      onOpen={open}
    />,
  );
  expect(screen.getByRole("img").getAttribute("src")).toBe("https://example.org/anime.png");
  view.rerender(<Card persona={profile} onChoose={select} onOpen={open} />);
  expect(screen.getByRole("img").getAttribute("src")).toBe(profile.imageUrl);
});

test("a newly mounted card preserves focus on existing navigation", () => {
  const view = render(
    <div>
      <button type="button">설정</button>
    </div>,
  );
  const navigation = screen.getByRole("button", { name: "설정" });
  navigation.focus();
  view.rerender(
    <div>
      <button type="button">설정</button>
      <Card
        persona={profile}
        onChoose={vi.fn<(like: boolean) => void>()}
        onOpen={vi.fn<(persona: typeof profile) => void>()}
      />
    </div>,
  );
  expect(document.activeElement).toBe(navigation);
});
