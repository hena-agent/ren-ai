import { act, cleanup, fireEvent, screen } from "@testing-library/react";
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
  dismissGuide();
  fireEvent.click(screen.getByRole("button", { name: like ? "좋아요" : "넘기기" }));
  endAnimation(document.querySelector(".profile-card")!);
}

export function selectDropdown(label: string, next: string) {
  dismissGuide();
  const trigger = screen.getByRole("combobox", { name: label });
  fireEvent.keyDown(trigger, { key: "ArrowDown", code: "ArrowDown" });
  const option = screen.getByRole("option", { name: next });
  fireEvent.click(option);
  return trigger;
}

export async function selectImageStyle(label: string) {
  dismissGuide();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: label }));
  });
}

export const swipeSurface = () => document.querySelector<HTMLElement>(".swipe-surface")!;

// happy-dom has no layout: every element is a 300×400 photo, except the name line, which starts at y=280.
export function layOutCard() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this.tagName === "H2" ? new DOMRect(24, 280, 252, 40) : new DOMRect(0, 0, 300, 400);
  });
}

export function tap(target: Element, clientX: number, clientY = 100) {
  dismissGuide();
  const pointer = { clientX, clientY, pointerId: 1, isPrimary: true, button: 0 };
  fireEvent.pointerDown(target, pointer);
  fireEvent.pointerUp(target, pointer);
  fireEvent.click(target, { clientX, clientY, detail: 1 });
}

export function dismissGuide() {
  const button = document.querySelector<HTMLButtonElement>(".guide[open] .primary-button");
  if (button) fireEvent.click(button);
}
