import { cleanup, fireEvent, screen } from "@testing-library/react";
import { vi } from "vitest";

export function resetCardTest() {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
}
export function preferReducedMotion() {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  Object.defineProperty(query, "matches", { value: true });
  vi.spyOn(window, "matchMedia").mockReturnValue(query);
  vi.useFakeTimers();
}

export function endAnimation(element: Element, name = "card-exit") {
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: name });
  fireEvent(element, event);
}

export function choose(like: boolean) {
  fireEvent.click(screen.getByRole("button", { name: like ? "좋아요" : "넘기기" }));
  endAnimation(document.querySelector(".profile-card")!);
}

export const swipeSurface = () => document.querySelector<HTMLElement>(".swipe-surface")!;
