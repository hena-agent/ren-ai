import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./app.tsx";
import { Card } from "./card.tsx";
import { ProfileDetails } from "./profile-details.tsx";
import { withImageStyle } from "./image-style.ts";
import {
  choose,
  endAnimation,
  layOutCard,
  resetCardTest,
  selectImageStyle,
  tap,
} from "../test/choose.ts";

afterEach(() => {
  resetCardTest();
  localStorage.clear();
});
const people = [2, 4].map((count, index) => ({
  id: `person${index}`,
  name: index ? "미라" : "하린",
  bio: "소개",
  imageUrl: `https://example.net/${index}-base.jpg`,
  portraitGallery: Array.from({ length: count }, (_, scene) => ({
    anime: `https://example.net/${index}-${scene}-anime.jpg`,
    photo: `https://example.net/${index}-${scene}-photo.jpg`,
  })),
}));
const client = testClient({
  profiles: async () => people,
  join: async () => ({ status: "waiting" as const }),
});

test.each(["anime", "photo"] as const)(
  "%s gallery prepares neighboring photos before photo changes in cards and expanded profiles",
  (style) => {
    const persona = withImageStyle(people[1]!, style);
    const actions = { onOpen: vi.fn<() => void>(), onChoose: vi.fn<() => void>() };
    const preloaded = (index: number) =>
      document.head.querySelector(
        `link[rel="preload"][as="image"][fetchpriority="low"][href="${persona.imageUrls![index]}"]`,
      );
    const view = render(<Card persona={persona} {...actions} />);
    expect(preloaded(1)).not.toBeNull();
    expect(preloaded(3)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "사진 4 / 4" }));
    expect(preloaded(2)).not.toBeNull();
    view.rerender(<Card persona={persona} {...actions} onCollapse={vi.fn<() => void>()} />);
    fireEvent.click(screen.getByRole("button", { name: "이전 사진" }));
    expect(screen.getByRole("img").getAttribute("src")).toBe(persona.imageUrls![2]);
    expect(preloaded(3)).not.toBeNull();
  },
);

test("persona-sized photo navigation preserves the image index on style changes and does not create Likes", async () => {
  localStorage.setItem("ren-ai.discovery.image-style", "anime");
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "하린" });
  expect(screen.getByRole("button", { name: "이전 사진" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "다음 사진" }));
  expect(screen.getByRole("img", { name: "하린 프로필" }).getAttribute("src")).toBe(
    people[0]!.portraitGallery[1]!.anime,
  );
  expect(screen.getByRole("button", { name: "사진 2 / 2" }).getAttribute("aria-current")).toBe(
    "step",
  );
  expect(screen.getByRole("button", { name: "다음 사진" }).hasAttribute("disabled")).toBe(true);
  expect(
    screen.getByRole("button", { name: "사진 1 / 2" }).getAttribute("aria-current"),
  ).toBeNull();
  expect(screen.getByText("2 / 2")).toBeTruthy();
  await selectImageStyle("실사");
  expect(screen.getByRole("img", { name: "하린 프로필" }).getAttribute("src")).toBe(
    people[0]!.portraitGallery[1]!.photo,
  );
  expect(localStorage.getItem("ren-ai.discovery.choices")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "하린 소개 전체 보기" }));
  const dialog = screen.getByRole("region", { name: "하린" });
  expect(within(dialog).getByRole("img").getAttribute("src")).toBe(
    people[0]!.portraitGallery[1]!.photo,
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "이전 사진" }));
  expect(within(dialog).getByRole("img").getAttribute("src")).toBe(
    people[0]!.portraitGallery[0]!.photo,
  );
  fireEvent.keyDown(dialog, { key: "Tab" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
  fireEvent.click(within(dialog).getByRole("button", { name: "프로필 접기" }));
  expect(screen.getByRole("img", { name: "하린 프로필" }).getAttribute("src")).toBe(
    people[0]!.portraitGallery[0]!.photo,
  );
  choose(true);
  expect(screen.getByRole("button", { name: "사진 4 / 4" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "미라 프로필" }).getAttribute("src")).toBe(
    people[1]!.portraitGallery[0]!.photo,
  );
  fireEvent.click(screen.getByRole("button", { name: "사진 4 / 4" }));
  expect(screen.getByRole("img", { name: "미라 프로필" }).getAttribute("src")).toBe(
    people[1]!.portraitGallery[3]!.photo,
  );
  fireEvent.click(screen.getByRole("button", { name: "사진 1 / 4" }));
  expect(screen.getByRole("img", { name: "미라 프로필" }).getAttribute("src")).toBe(
    people[1]!.portraitGallery[0]!.photo,
  );
  expect(localStorage.getItem("ren-ai.discovery.choices")).toContain('"person0":true');
});

test("a changing gallery clamps the current picture and single-image cards hide gallery controls", () => {
  const persona = withImageStyle(people[1]!, "anime");
  const onOpen = vi.fn<() => void>();
  const onChoose = vi.fn<() => void>();
  const view = render(<Card persona={persona} onOpen={onOpen} onChoose={onChoose} />);
  expect(document.querySelector(".profile-card")?.getAttribute("data-gallery")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "사진 4 / 4" }));
  fireEvent.click(screen.getByRole("button", { name: "미라 소개 전체 보기" }));
  expect(onOpen).toHaveBeenCalledWith(persona, 3);
  view.rerender(
    <Card
      persona={{ ...persona, imageUrls: persona.imageUrls!.slice(0, 2) }}
      onOpen={onOpen}
      onChoose={onChoose}
    />,
  );
  expect(screen.getByRole("img").getAttribute("src")).toBe(persona.imageUrls![1]);
  view.rerender(
    <Card
      persona={{ ...persona, imageUrls: [persona.imageUrl] }}
      onOpen={onOpen}
      onChoose={onChoose}
    />,
  );
  expect(screen.queryByRole("button", { name: /사진/ })).toBeNull();
  expect(document.querySelector(".profile-card")?.getAttribute("data-gallery")).toBe("false");
  view.rerender(<Card persona={persona} onOpen={onOpen} onChoose={onChoose} />);
  fireEvent.click(screen.getByRole("button", { name: "좋아요" }));
  expect(
    [...document.querySelectorAll<HTMLButtonElement>(".gallery-controls button")].every(
      (button) => button.disabled,
    ),
  ).toBe(true);
});

test("inline details clamp changed collections and leave Tab to native navigation", () => {
  const persona = withImageStyle(people[1]!, "photo");
  const onClose = vi.fn<() => void>();
  const change = vi.fn<(image: number) => void>();
  const view = render(
    <ProfileDetails
      persona={persona}
      image={3}
      onImageChange={change}
      onClose={onClose}
      disabled={false}
    />,
  );
  const dialog = screen.getByRole("region");
  const close = within(dialog).getByRole("button", { name: "프로필 접기" });
  close.focus();
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  fireEvent(dialog, tab);
  expect(tab.defaultPrevented).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "이전 사진" }));
  expect(change).toHaveBeenCalledWith(2);
  view.rerender(
    <ProfileDetails
      persona={{ ...persona, imageUrls: persona.imageUrls!.slice(0, 2) }}
      image={3}
      onImageChange={change}
      disabled={true}
      onClose={onClose}
    />,
  );
  expect(within(dialog).getByRole("img").getAttribute("src")).toBe(persona.imageUrls![1]);
  expect(close.hasAttribute("disabled")).toBe(true);
});
import { testClient } from "../test/client.ts";

test("tapping the halves of an expanded photo changes it, the ends nudge, and a disabled profile ignores taps", () => {
  layOutCard();
  const persona = withImageStyle(people[1]!, "photo");
  const change = vi.fn<(image: number) => void>();
  const details = (image: number, disabled = false) => (
    <ProfileDetails
      persona={persona}
      image={image}
      onImageChange={change}
      onClose={vi.fn<() => void>()}
      disabled={disabled}
    />
  );
  const view = render(details(1));
  const surface = document.querySelector<HTMLElement>(".details-surface")!;
  tap(surface, 280);
  expect(change).toHaveBeenLastCalledWith(2);
  tap(surface, 20);
  expect(change).toHaveBeenLastCalledWith(0);
  view.rerender(details(0));
  tap(surface, 20);
  expect(surface.getAttribute("data-nudge")).toBe("previous");
  endAnimation(surface, "photo-nudge");
  expect(surface.hasAttribute("data-nudge")).toBe(false);
  view.rerender(details(3));
  tap(surface, 280);
  expect(surface.getAttribute("data-nudge")).toBe("next");
  endAnimation(surface, "photo-nudge");
  view.rerender(details(1, true));
  tap(surface, 280);
  tap(surface, 20);
  expect(surface.hasAttribute("data-nudge")).toBe(false);
  expect(change).toHaveBeenCalledTimes(2);
});
