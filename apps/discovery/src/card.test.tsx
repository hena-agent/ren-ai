import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Card } from "./card.tsx";

afterEach(cleanup);
const profile = {
  id: "yerin",
  name: "예린",
  bio: "필름 사진을 찍어요.",
  imageUrl: "https://example.org/yerin.png",
};
const point = (x: number, pointerId = 1) => ({ clientX: x, pointerId, isPrimary: true, button: 0 });

test("a profile supports pointer swipes, keyboard arrows and a native Like button", () => {
  const select = vi.fn<(like: boolean) => void>();
  render(<Card persona={profile} onChoose={select} />);
  const surface = screen.getByRole("button", { name: "예린 프로필 카드 좋아요" });
  expect(screen.getByRole("img").getAttribute("src")).toBe("https://example.org/yerin.png");
  expect(screen.getByRole("img").getAttribute("draggable")).toBe("false");
  expect(screen.queryByText("LIKE")).toBeNull();
  expect(screen.queryByText("PASS")).toBeNull();
  fireEvent.pointerDown(surface, point(100));
  fireEvent.pointerMove(surface, point(160));
  expect(screen.getByText("LIKE")).toBeTruthy();
  expect(surface.closest("article")?.style.transform).toBe("translateX(60px) rotate(2.5deg)");
  fireEvent.pointerUp(surface, point(190));
  expect(select).toHaveBeenLastCalledWith(true);
  expect(surface.closest("article")?.style.transform).toBe("translateX(0px) rotate(0deg)");
  fireEvent.pointerDown(surface, point(200));
  fireEvent.pointerMove(surface, point(150));
  expect(screen.getByText("PASS")).toBeTruthy();
  fireEvent.pointerUp(surface, point(110));
  expect(select).toHaveBeenLastCalledWith(false);
  const left = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
  fireEvent(surface, left);
  expect(left.defaultPrevented).toBe(true);
  expect(select).toHaveBeenLastCalledWith(false);
  fireEvent.keyDown(surface, { key: "ArrowRight" });
  expect(select).toHaveBeenLastCalledWith(true);
  fireEvent.click(surface);
  expect(select).toHaveBeenLastCalledWith(true);
  expect(select).toHaveBeenCalledTimes(5);
});

test("small gestures, cancelled pointers, other fingers and secondary clicks do not choose", () => {
  const select = vi.fn<(like: boolean) => void>();
  render(<Card persona={profile} onChoose={select} />);
  const surface = screen.getByRole("button");
  const capture = vi.fn<(id: number) => void>();
  const errors = vi.fn<(event: ErrorEvent) => void>();
  window.addEventListener("error", errors);
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
  expect(select).not.toHaveBeenCalled();
  expect(surface.closest("article")?.style.transform).toBe("translateX(0px) rotate(0deg)");
  fireEvent.pointerUp(surface, point(139));
  expect(select).not.toHaveBeenCalled();
  fireEvent.pointerDown(surface, point(200));
  fireEvent.pointerMove(surface, point(190));
  expect(screen.queryByText("PASS")).toBeNull();
  fireEvent.pointerCancel(surface);
  fireEvent.pointerUp(surface, point(100));
  fireEvent.keyDown(surface, { key: "Home" });
  expect(select).not.toHaveBeenCalled();
  expect(surface.closest("article")?.style.transform).toBe("translateX(0px) rotate(0deg)");
  expect(errors).not.toHaveBeenCalled();
  window.removeEventListener("error", errors);
});

test("the Like and Pass stamps appear only beyond the visual drag boundary", () => {
  render(<Card persona={profile} onChoose={vi.fn<(like: boolean) => void>()} />);
  const surface = screen.getByRole("button");
  fireEvent.pointerDown(surface, point(100));
  fireEvent.pointerMove(surface, point(124));
  expect(screen.queryByText("LIKE")).toBeNull();
  fireEvent.pointerMove(surface, point(125));
  expect(screen.getByText("LIKE")).toBeTruthy();
  fireEvent.pointerMove(surface, point(76));
  expect(screen.queryByText("PASS")).toBeNull();
  fireEvent.pointerMove(surface, point(75));
  expect(screen.getByText("PASS")).toBeTruthy();
});

test("an unavailable photograph keeps the persona and Like action usable", () => {
  const select = vi.fn<(like: boolean) => void>();
  render(<Card persona={profile} onChoose={select} />);
  fireEvent.error(screen.getByRole("img"));
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("예")).toBeTruthy();
  expect(screen.getByText("사진을 불러오지 못했어요.")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "예린" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button"));
  expect(select).toHaveBeenCalledWith(true);
});
