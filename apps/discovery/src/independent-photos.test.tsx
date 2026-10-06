import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "./app.tsx";
import { withImageStyle } from "./image-style.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const person = {
  id: "self",
  name: "한서우",
  bio: "제가 골라 올린 소개예요.",
  imageUrl: "https://example.net/main-photo.jpg",
  portraits: {
    anime: "https://example.net/main-anime.jpg",
    photo: "https://example.net/main-photo.jpg",
  },
  secondaryPortraits: [
    { style: "photo" as const, imageUrl: "https://example.net/selfie.jpg" },
    { style: "anime" as const, imageUrl: "https://example.net/travel-anime.jpg" },
    { style: "photo" as const, imageUrl: "https://example.net/full-body.jpg" },
  ],
};

test("style-specific independent photos display only that style's remaining main and secondary images", async () => {
  localStorage.setItem("ren-ai.discovery.image-style", "photo");
  render(
    <App client={{ profiles: async () => [person], join: async () => ({ status: "waiting" }) }} />,
  );
  await screen.findByRole("heading", { name: person.name });
  expect(screen.getByRole("button", { name: "사진 3 / 3" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다음 사진" }));
  expect(screen.getByRole("img").getAttribute("src")).toBe(person.secondaryPortraits[0]!.imageUrl);
  fireEvent.click(screen.getByRole("button", { name: "애니메" }));
  expect(screen.queryByRole("button", { name: "사진 3 / 3" })).toBeNull();
  expect(screen.getByRole("img").getAttribute("src")).toBe(person.secondaryPortraits[1]!.imageUrl);
});

test("a style with no photos displays a clear placeholder rather than reintroducing deleted opposite-style images", async () => {
  const remaining = {
    ...person,
    portraits: { anime: person.portraits.anime },
    secondaryPortraits: [],
  };
  expect(withImageStyle(remaining, "photo").imageUrl).toBe("");
  const mainOnly = {
    id: person.id,
    name: person.name,
    bio: person.bio,
    imageUrl: person.imageUrl,
    portraits: remaining.portraits,
  };
  expect(withImageStyle(mainOnly, "photo").imageUrl).toBe("");
  expect(withImageStyle(mainOnly, "photo").imageUrls).toEqual([""]);
  expect(withImageStyle(mainOnly, "anime").imageUrls).toEqual([person.portraits.anime]);
  localStorage.setItem("ren-ai.discovery.image-style", "photo");
  render(
    <App
      client={{ profiles: async () => [remaining], join: async () => ({ status: "waiting" }) }}
    />,
  );
  await screen.findByRole("heading", { name: person.name });
  expect(screen.getByText("이 스타일의 사진이 아직 없어요.")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: `${person.name} 소개 전체 보기` }));
  expect(
    within(screen.getByRole("region", { name: person.name })).getByText(
      "이 스타일의 사진이 아직 없어요.",
    ),
  ).toBeTruthy();
  expect(within(screen.getByRole("region", { name: person.name })).getByText("한")).toBeTruthy();
});

test("independent secondary photos still work when an older optional main field is absent", () => {
  const secondaryOnly = {
    id: person.id,
    name: person.name,
    bio: person.bio,
    imageUrl: person.imageUrl,
    secondaryPortraits: person.secondaryPortraits,
  };
  expect(withImageStyle(secondaryOnly, "anime").imageUrls).toEqual([
    person.secondaryPortraits[1]!.imageUrl,
  ]);
});
