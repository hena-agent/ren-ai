import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Card } from "./card.tsx";
import type { StyledPersona } from "./image-style.ts";
import {
  endAnimation,
  layOutCard,
  preferReducedMotion,
  resetCardTest,
  swipeSurface,
  tap,
} from "../test/choose.ts";

afterEach(resetCardTest);
const photos = [0, 1, 2].map((index) => `https://example.net/mira-${index}.jpg`);
const mira: StyledPersona = {
  id: "mira",
  name: "미라",
  bio: "소개",
  imageUrl: photos[0]!,
  imageUrls: photos,
};
const shown = () => screen.getByRole("img").getAttribute("src");

function browse(persona = mira) {
  const onOpen = vi.fn<(persona: StyledPersona, image?: number) => void>();
  layOutCard();
  render(<Card persona={persona} onChoose={vi.fn<(like: boolean) => void>()} onOpen={onOpen} />);
  return { onOpen, surface: swipeSurface() };
}

test("tapping the middle third of the photo opens the profile at the photo on screen", () => {
  const { onOpen, surface } = browse();
  tap(surface, 150);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(mira, 0);
});

test("tapping the right third shows the next photo and the left third the previous one", () => {
  const { onOpen, surface } = browse();
  tap(surface, 280);
  tap(surface, 280);
  expect(shown()).toBe(photos[2]);
  tap(surface, 20);
  expect(shown()).toBe(photos[1]);
  tap(surface, 150);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(mira, 1);
});

test("a tap from the name line down opens the profile on any side, and above it keeps its photo zone", () => {
  const { onOpen, surface } = browse();
  tap(surface, 20, 280);
  tap(surface, 280, 399);
  expect(onOpen).toHaveBeenCalledTimes(2);
  tap(surface, 280, 279);
  expect(shown()).toBe(photos[1]);
  expect(onOpen).toHaveBeenCalledTimes(2);
});

test("tapping past the first or last photo nudges it until the animation ends", () => {
  const { surface } = browse();
  tap(surface, 20);
  expect(surface.getAttribute("data-nudge")).toBe("previous");
  expect(shown()).toBe(photos[0]);
  endAnimation(surface, "photo-nudge");
  expect(surface.hasAttribute("data-nudge")).toBe(false);
  tap(surface, 280);
  tap(surface, 280);
  expect(surface.hasAttribute("data-nudge")).toBe(false);
  tap(surface, 280);
  expect(surface.getAttribute("data-nudge")).toBe("next");
  expect(shown()).toBe(photos[2]);
});

test("a card with one photo nudges from both sides and opens from the middle without a photo", () => {
  const single = { ...mira, imageUrls: [photos[0]!] };
  const { onOpen, surface } = browse(single);
  tap(surface, 280);
  expect(surface.getAttribute("data-nudge")).toBe("next");
  tap(surface, 20);
  expect(surface.getAttribute("data-nudge")).toBe("previous");
  tap(surface, 150);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(single);
});

test("reduced motion skips the nudge", () => {
  preferReducedMotion();
  const { surface } = browse();
  tap(surface, 20);
  expect(surface.hasAttribute("data-nudge")).toBe(false);
});

test("taps on a card that is already leaving do nothing", () => {
  const { onOpen, surface } = browse();
  fireEvent.click(screen.getByRole("button", { name: "좋아요" }));
  tap(surface, 150);
  tap(surface, 280);
  expect(onOpen).not.toHaveBeenCalled();
  expect(shown()).toBe(photos[0]);
});

test("keyboard and screen-reader users keep invisible buttons for the same three actions", () => {
  const { onOpen } = browse();
  for (const name of ["이전 사진", "다음 사진", "미라 소개 전체 보기"])
    expect(screen.getByRole("button", { name }).childElementCount).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "다음 사진" }));
  expect(shown()).toBe(photos[1]);
  fireEvent.click(screen.getByRole("button", { name: "미라 소개 전체 보기" }));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(mira, 1);
});

test("the photo position is announced to screen readers but not drawn", () => {
  browse();
  const position = screen.getByText("1 / 3");
  expect(position.className).toContain("sr-only");
  expect(position.getAttribute("aria-live")).toBe("polite");
});
