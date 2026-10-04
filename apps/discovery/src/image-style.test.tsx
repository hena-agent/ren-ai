import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { discoveryNotice } from "@ren-ai/onboarding";
import { App } from "./app.tsx";
import type { DiscoveryClient } from "./client.ts";
import { readImageStyle, saveImageStyle } from "./image-style.ts";
import { choose } from "../test/choose.ts";
import { fakeVerification } from "../test/turnstile.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete window.turnstile;
});
const people = ["하린", "지우", "미라"].map((name, index) => ({
  id: `persona${index}`,
  name,
  bio: "함께 이야기해요.",
  imageUrl: `https://example.net/${index}-legacy.jpg`,
  portraits: {
    anime: `https://example.net/${index}-anime.jpg`,
    photo: `https://example.net/${index}-photo.jpg`,
  },
}));
const client: DiscoveryClient = {
  profiles: async () => people,
  join: async () => ({ status: "waiting" }),
};
const comparisonImages = () =>
  [...document.querySelectorAll(".style-previews img")].map((image) => image.getAttribute("src"));

test("first-time visitors select a style before browsing and can change the whole deck", async () => {
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "어떤 느낌으로 만나볼까요?" });
  expect(comparisonImages()).toEqual([people[0]!.portraits.anime, people[0]!.portraits.photo]);
  expect(screen.queryByRole("heading", { name: "하린" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /애니메/ }));
  expect(screen.getByRole("img", { name: "하린 프로필" }).getAttribute("src")).toBe(
    people[0]!.portraits.anime,
  );
  expect(screen.getByRole("button", { name: "애니메" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "실사" }).getAttribute("aria-pressed")).toBe("false");
  expect(
    screen.queryByText(
      "이 브라우저에 이미지 스타일을 보관하지 못했어요. 지금 선택은 계속 사용할 수 있어요.",
    ),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "실사" }));
  expect(screen.getByRole("img", { name: "하린 프로필" }).getAttribute("src")).toBe(
    people[0]!.portraits.photo,
  );
  expect(screen.getByRole("button", { name: "실사" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "애니메" }).getAttribute("aria-pressed")).toBe("false");
  expect(localStorage.getItem("ren-ai.discovery.image-style")).toBe("photo");
});

test("the initial comparison uses a paired persona even when a legacy profile appears first", async () => {
  render(
    <App
      client={{
        ...client,
        profiles: async () => [
          {
            id: "legacy",
            name: "기존 인물",
            bio: "소개",
            imageUrl: "https://example.net/legacy.jpg",
          },
          ...people,
        ],
      }}
    />,
  );
  await screen.findByRole("heading", { name: "어떤 느낌으로 만나볼까요?" });
  expect(comparisonImages()).toEqual([people[0]!.portraits.anime, people[0]!.portraits.photo]);
  fireEvent.click(screen.getByRole("button", { name: /애니메/ }));
  expect(screen.getByRole("img", { name: "기존 인물 프로필" }).getAttribute("src")).toBe(
    "https://example.net/legacy.jpg",
  );
});

test("style changes and reloads preserve Like and Pass, contact input and candidate IDs", async () => {
  const join = vi.fn<DiscoveryClient["join"]>().mockResolvedValue({ status: "waiting" });
  const verify = fakeVerification();
  localStorage.setItem("ren-ai.discovery.image-style", "anime");
  const first = render(<App client={{ ...client, join }} />);
  await screen.findByRole("heading", { name: "하린" });
  expect(
    screen.queryByText(
      "이 브라우저에 이미지 스타일을 보관하지 못했어요. 지금 선택은 계속 사용할 수 있어요.",
    ),
  ).toBeNull();
  choose(true);
  choose(false);
  expect(screen.getByRole("heading", { name: "미라" })).toBeTruthy();
  const saved = localStorage.getItem("ren-ai.discovery.choices");
  fireEvent.click(screen.getByRole("button", { name: "실사" }));
  expect(localStorage.getItem("ren-ai.discovery.choices")).toBe(saved);
  expect(screen.getByRole("img", { name: "미라 프로필" }).getAttribute("src")).toBe(
    people[2]!.portraits.photo,
  );
  first.unmount();
  render(<App client={{ ...client, join }} />);
  await screen.findByRole("heading", { name: "미라" });
  expect(screen.queryByRole("heading", { name: "어떤 느낌으로 만나볼까요?" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /연락받기/ }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "01012345678" } });
  fireEvent.click(screen.getByRole("button", { name: "애니메" }));
  expect(screen.getByRole("textbox").getAttribute("value")).toBe("01012345678");
  expect(
    screen
      .getByRole("list", { name: "관심을 전할 페르소나" })
      .querySelector("img")
      ?.getAttribute("src"),
  ).toBe(people[0]!.portraits.anime);
  fireEvent.click(screen.getByRole("checkbox", { name: discoveryNotice.consent }));
  act(() => verify("human"));
  fireEvent.click(screen.getByRole("button", { name: "동의하고 대기 등록" }));
  await screen.findByRole("heading", { name: "대기 등록이 완료됐어요." });
  expect(join.mock.calls[0]?.[0].likedPersonaIDs).toEqual(["persona0"]);
});

test("legacy portraits remain usable and blocked storage does not prevent an active style choice", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  });
  render(
    <App
      client={{
        ...client,
        profiles: async () => [
          {
            id: "legacy",
            name: "옛 인물",
            bio: "소개",
            imageUrl: "https://example.net/legacy.jpg",
          },
        ],
      }}
    />,
  );
  await screen.findByRole("heading", { name: "어떤 느낌으로 만나볼까요?" });
  fireEvent.click(screen.getByRole("button", { name: /실사/ }));
  expect(screen.getByRole("img", { name: "옛 인물 프로필" }).getAttribute("src")).toBe(
    "https://example.net/legacy.jpg",
  );
  expect(
    screen.getByText(
      "이 브라우저에 이미지 스타일을 보관하지 못했어요. 지금 선택은 계속 사용할 수 있어요.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "애니메" }));
  expect(screen.getByRole("img", { name: "옛 인물 프로필" })).toBeTruthy();
});

test("a style change retries a previously broken image without changing the persona", async () => {
  localStorage.setItem("ren-ai.discovery.image-style", "photo");
  render(<App client={client} />);
  const image = await screen.findByRole("img", { name: "하린 프로필" });
  fireEvent.error(image);
  expect(screen.queryByRole("img", { name: "하린 프로필" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "애니메" }));
  expect(screen.getByRole("img", { name: "하린 프로필" }).getAttribute("src")).toBe(
    people[0]!.portraits.anime,
  );
});

test("only supported style values are restored and persistence failures are reported", () => {
  expect(readImageStyle()).toBeUndefined();
  expect(saveImageStyle("anime")).toBe(true);
  expect(readImageStyle()).toBe("anime");
  expect(saveImageStyle("photo")).toBe(true);
  expect(readImageStyle()).toBe("photo");
  localStorage.setItem("ren-ai.discovery.image-style", "unexpected");
  expect(readImageStyle()).toBeUndefined();
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  });
  expect(readImageStyle()).toBeUndefined();
  expect(saveImageStyle("anime")).toBe(false);
});
