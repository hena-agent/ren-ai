import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./app.tsx";
import type { DiscoveryClient } from "./client.ts";
import { readImageStyle, saveImageStyle } from "./image-style.ts";
import { choose, selectImageStyle } from "../test/choose.ts";
import { fakeVerification, submitVerifiedContact } from "../test/turnstile.ts";
import { testClient } from "../test/client.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  performance.clearMarks("discovery.imageStyle.failed");
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
const client = testClient({
  profiles: async () => people,
  join: async () => ({ status: "waiting" }),
});

test.each(["anime", "photo"] as const)(
  "production restores %s and exposes the style switch",
  async (style) => {
    vi.stubEnv("DEV", false);
    localStorage.setItem("ren-ai.discovery.image-style", style);
    render(<App client={client} />);
    await screen.findByRole("heading", { name: "하린" });
    expect(screen.getByRole("img", { name: "하린 프로필" }).getAttribute("src")).toBe(
      people[0]!.portraits[style],
    );
    expect(
      screen
        .getByRole("button", { name: style === "anime" ? "애니메" : "실사" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await selectImageStyle(style === "anime" ? "실사" : "애니메");
    expect(screen.getByRole("img", { name: "하린 프로필" }).getAttribute("src")).toBe(
      people[0]!.portraits[style === "anime" ? "photo" : "anime"],
    );
  },
);

test("first visits open anime immediately and changing style does not reset the deck", async () => {
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "하린" });
  expect(screen.queryByRole("heading", { name: "어떤 느낌으로 만나볼까요?" })).toBeNull();
  expect(screen.getByRole("img", { name: "하린 프로필" }).getAttribute("src")).toBe(
    people[0]!.portraits.anime,
  );
  const decode = vi.spyOn(HTMLImageElement.prototype, "decode");
  await selectImageStyle("애니메");
  expect(decode).not.toHaveBeenCalled();
  choose(false);
  await selectImageStyle("실사");
  expect(screen.getByRole("img", { name: "지우 프로필" }).getAttribute("src")).toBe(
    people[1]!.portraits.photo,
  );
  expect(localStorage.getItem("ren-ai.discovery.image-style")).toBe("photo");
});

test("a legacy profile before styled profiles remains usable with the anime default", async () => {
  render(
    <App
      client={testClient({
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
      })}
    />,
  );
  await screen.findByRole("heading", { name: "기존 인물" });
  expect(screen.getByRole("img", { name: "기존 인물 프로필" }).getAttribute("src")).toBe(
    "https://example.net/legacy.jpg",
  );
  choose(false);
  expect(screen.getByRole("img", { name: "하린 프로필" }).getAttribute("src")).toBe(
    people[0]!.portraits.anime,
  );
});

test("preparation keeps the old image, prevents repeat requests and retains keyboard focus", async () => {
  let finish: () => void = vi.fn<() => void>();
  const prepared = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const decode = vi.spyOn(HTMLImageElement.prototype, "decode").mockReturnValue(prepared);
  render(<App client={testClient({ ...client, profiles: async () => [people[0]!] })} />);
  await screen.findByRole("heading", { name: "하린" });
  const target = screen.getByRole("button", { name: "실사" });
  target.focus();
  fireEvent.click(target);
  expect(document.querySelector(".app-workspace")?.hasAttribute("inert")).toBe(true);
  expect(
    within(screen.getByRole("group", { name: "이미지 스타일" })).getByRole("status").textContent,
  ).toBe("이미지 스타일을 바꾸고 있어요.");
  expect(document.querySelector(".profile-photo")?.getAttribute("src")).toBe(
    people[0]!.portraits.anime,
  );
  fireEvent.click(screen.getByRole("button", { name: "애니메" }));
  fireEvent.click(target);
  expect(decode).toHaveBeenCalledOnce();
  await act(async () => {
    finish();
  });
  expect(document.querySelector(".app-workspace")?.hasAttribute("inert")).toBe(false);
  expect(screen.getByRole("img", { name: "하린 프로필" }).getAttribute("src")).toBe(
    people[0]!.portraits.photo,
  );
  expect(document.activeElement).toBe(target);
});

test("style changes and reloads preserve Like and Pass, contact input and candidate IDs", async () => {
  const join = vi.fn<DiscoveryClient["join"]>().mockResolvedValue({ status: "waiting" });
  const verify = fakeVerification();
  const first = render(<App client={{ ...client, join }} />);
  await screen.findByRole("heading", { name: "하린" });
  choose(true);
  choose(false);
  const saved = localStorage.getItem("ren-ai.discovery.choices");
  await selectImageStyle("실사");
  expect(localStorage.getItem("ren-ai.discovery.choices")).toBe(saved);
  expect(screen.getByRole("img", { name: "미라 프로필" }).getAttribute("src")).toBe(
    people[2]!.portraits.photo,
  );
  first.unmount();
  render(<App client={{ ...client, join }} />);
  await screen.findByRole("heading", { name: "미라" });
  fireEvent.click(screen.getByRole("button", { name: /연락받기/ }));
  const phone = screen.getByRole("textbox", { name: "휴대전화 번호" });
  fireEvent.change(phone, { target: { value: "01012345678" } });
  await selectImageStyle("애니메");
  expect(screen.getByRole("textbox", { name: "휴대전화 번호" })).toBe(phone);
  expect(phone.getAttribute("value")).toBe("010-1234-5678");
  expect(
    screen
      .getByRole("list", { name: "관심을 전할 페르소나" })
      .querySelector("img")
      ?.getAttribute("src"),
  ).toBe(people[0]!.portraits.anime);
  submitVerifiedContact(verify);
  await screen.findByRole("heading", { name: "대기 등록이 완료됐어요." });
  expect(join.mock.calls[0]?.[0].likedPersonaIDs).toEqual(["persona0"]);
  expect(join.mock.calls[0]?.[0]).toHaveProperty("imageStyle", "anime");
});

test("contact submits the current photo style even when browser storage is blocked", async () => {
  const join = vi.fn<DiscoveryClient["join"]>().mockResolvedValue({ status: "waiting" });
  const verify = fakeVerification();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  render(<App client={{ ...client, join }} />);
  await screen.findByRole("heading", { name: "하린" });
  choose(true);
  fireEvent.click(screen.getByRole("button", { name: /연락받기/ }));
  await selectImageStyle("실사");
  fireEvent.change(screen.getByRole("textbox", { name: "휴대전화 번호" }), {
    target: { value: "01012345678" },
  });
  submitVerifiedContact(verify);
  await screen.findByRole("heading", { name: "대기 등록이 완료됐어요." });
  expect(join.mock.calls[0]?.[0]).toHaveProperty("imageStyle", "photo");
});

test("blocked storage permits an active style choice and reports persistence failure", async () => {
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
      client={testClient({
        ...client,
        profiles: async () => [
          {
            id: "legacy",
            name: "옛 인물",
            bio: "소개",
            imageUrl: "https://example.net/legacy.jpg",
          },
        ],
      })}
    />,
  );
  await screen.findByRole("heading", { name: "옛 인물" });
  await selectImageStyle("실사");
  expect(screen.getByRole("button", { name: "실사" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("alert").textContent).toContain("이미지 스타일을 보관하지 못했어요");
  await selectImageStyle("애니메");
  expect(screen.getByRole("img", { name: "옛 인물 프로필" })).toBeTruthy();
});

test("a style change retries a broken portrait without changing the persona", async () => {
  localStorage.setItem("ren-ai.discovery.image-style", "photo");
  render(<App client={client} />);
  fireEvent.error(await screen.findByRole("img", { name: "하린 프로필" }));
  expect(screen.queryByRole("img", { name: "하린 프로필" })).toBeNull();
  await selectImageStyle("애니메");
  expect(screen.getByRole("img", { name: "하린 프로필" }).getAttribute("src")).toBe(
    people[0]!.portraits.anime,
  );
});

function recordDecodes() {
  const requested: string[] = [];
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    requested.push(this.src);
    return Promise.resolve();
  });
  return requested;
}

test("switching while reading a liked profile prepares its photos and preserves the current deck", async () => {
  const requested = recordDecodes();
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "하린" });
  choose(true);
  fireEvent.click(screen.getByRole("button", { name: "하린 프로필 보기" }));
  const reading = screen.getByRole("region", { name: "하린" });
  await selectImageStyle("실사");
  expect(screen.getByRole("region", { name: "하린" })).toBe(reading);
  expect(within(reading).getByRole("img").getAttribute("src")).toBe(people[0]!.portraits.photo);
  expect(requested).toContain(people[0]!.portraits.photo);
  expect(requested).toContain(people[1]!.portraits.photo);
  fireEvent.click(within(reading).getByRole("button", { name: "프로필 접기" }));
  expect(screen.getByRole("img", { name: "지우 프로필" }).getAttribute("src")).toBe(
    people[1]!.portraits.photo,
  );
  expect(localStorage.getItem("ren-ai.discovery.choices")).toBe('{"persona0":true}');
});

const original = (n: number) =>
  `https://persona-images.renai.im/00000000-0000-0000-0000-00000000000${n}.png`;
const display = (n: number) =>
  `https://persona-images.renai.im/thumbnails/00000000-0000-0000-0000-00000000000${n}.jpg`;

test("owned gallery photos browse, prepare and read through their stored display renditions", async () => {
  const requested = recordDecodes();
  const gallery = [0, 1].map((index) => ({
    id: `owned${index}`,
    name: `사진${index}`,
    bio: "소개",
    imageUrl: original(index * 2 + 1),
    portraits: { anime: original(index * 2 + 1), photo: original(index * 2 + 2) },
  }));
  render(<App client={testClient({ ...client, profiles: async () => gallery })} />);
  await screen.findByRole("heading", { name: "사진0" });
  expect(screen.getByRole("img", { name: "사진0 프로필" }).getAttribute("src")).toBe(display(1));
  expect(document.querySelector(".card-back img")?.getAttribute("src")).toBe(display(3));
  await selectImageStyle("실사");
  expect(requested).toEqual([display(2), display(4)]);
  choose(true);
  expect(
    screen.getByRole("list", { name: "좋아한 사람" }).querySelector("img")?.getAttribute("src"),
  ).toBe(display(2));
  fireEvent.click(screen.getByRole("button", { name: "사진0 프로필 보기" }));
  expect(
    within(screen.getByRole("region", { name: "사진0" }))
      .getByRole("img")
      .getAttribute("src"),
  ).toBe(display(2));
});

test.each([new Error("private image URL and secret"), "private token"])(
  "failed preparation keeps the current view and records safe diagnostics (%#)",
  async (failure) => {
    const decode = vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValue(failure);
    const mark = vi.spyOn(performance, "mark");
    render(<App client={client} />);
    await screen.findByRole("heading", { name: "하린" });
    await selectImageStyle("실사");
    expect(screen.getByRole("alert").textContent).toContain("현재 모습은 그대로예요");
    expect(screen.getByRole("img", { name: "하린 프로필" }).getAttribute("src")).toBe(
      people[0]!.portraits.anime,
    );
    expect(localStorage.getItem("ren-ai.discovery.image-style")).toBeNull();
    const diagnostics = mark.mock.calls.filter(([name]) => name === "discovery.imageStyle.failed");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.[1]).toMatchObject({
      detail: {
        operation: "discovery.imageStyle",
        stage: "images.decode",
        outcome: "failed",
        code: "IMAGE_STYLE_CHANGE_FAILED",
      },
    });
    expect(JSON.stringify(mark.mock.calls)).not.toMatch(/private|secret|example\.net/);
    decode.mockResolvedValue(undefined);
    await selectImageStyle("실사");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("img", { name: "하린 프로필" }).getAttribute("src")).toBe(
      people[0]!.portraits.photo,
    );
  },
);

test("only supported styles restore and absent, invalid or blocked storage defaults to anime", () => {
  expect(readImageStyle()).toBe("anime");
  expect(saveImageStyle("anime")).toBe(true);
  expect(readImageStyle()).toBe("anime");
  expect(saveImageStyle("photo")).toBe(true);
  expect(readImageStyle()).toBe("photo");
  localStorage.setItem("ren-ai.discovery.image-style", "unexpected");
  expect(readImageStyle()).toBe("anime");
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  });
  expect(readImageStyle()).toBe("anime");
  expect(saveImageStyle("anime")).toBe(false);
});
