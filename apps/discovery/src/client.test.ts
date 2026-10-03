import { afterEach, expect, test, vi } from "vitest";
import { discoveryNotice } from "@ren-ai/onboarding";
import { discoveryClient } from "./client.ts";
import { readChoices, saveChoices } from "./choices.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.unstubAllEnvs();
});

test("the browser client reads the catalog and validates the real registration answer", async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  fetcher.mockResolvedValueOnce(
    Response.json([
      {
        id: "nari",
        name: "나리",
        bio: "책 읽는 오후를 좋아해요.",
        imageUrl: "https://example.net/nari.jpg",
        privatePrompt: "hidden",
      },
    ]),
  );
  expect(await discoveryClient.profiles(signal)).toEqual([
    {
      id: "nari",
      name: "나리",
      bio: "책 읽는 오후를 좋아해요.",
      imageUrl: "https://example.net/nari.jpg",
    },
  ]);
  expect(fetcher).toHaveBeenCalledWith("/discovery/personas", { signal });
  const request = {
    handle: "a@example.org",
    locale: "ko",
    privacyNoticeVersion: discoveryNotice.version,
    likedPersonaIDs: ["nari"],
    turnstileToken: "verified",
  } as const;
  fetcher.mockResolvedValueOnce(Response.json({ status: "waiting" }));
  expect(await discoveryClient.join(request)).toEqual({ status: "waiting" });
  expect(fetcher).toHaveBeenLastCalledWith("/discovery/waitlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  fetcher.mockResolvedValueOnce(Response.json({ status: "active" }));
  expect(await discoveryClient.join(request)).toEqual({ status: "active" });
  fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(discoveryClient.profiles(signal)).rejects.toThrow("Profiles unavailable");
  fetcher.mockResolvedValueOnce(new Response(null, { status: 400 }));
  await expect(discoveryClient.join(request)).rejects.toThrow("Registration unavailable");
  fetcher.mockResolvedValueOnce(Response.json({ status: "sent" }));
  await expect(discoveryClient.join(request)).rejects.toThrow(/status/);
  fetcher.mockResolvedValueOnce(
    Response.json([{ id: "bad", name: "잘못된 이미지", bio: "", imageUrl: "javascript:alert(1)" }]),
  );
  await expect(discoveryClient.profiles(signal)).rejects.toThrow(/bio|imageUrl/);
  for (const imageUrl of ["http://example.net/photo.jpg", "not-a-url", "javascript:alert(1)"]) {
    fetcher.mockResolvedValueOnce(
      Response.json([{ id: "valid", name: "이름", bio: "소개", imageUrl }]),
    );
    await expect(discoveryClient.profiles(signal)).rejects.toThrow(/imageUrl/);
  }
  for (const id of ["../escape", "ends/", "a".repeat(65)]) {
    fetcher.mockResolvedValueOnce(
      Response.json([{ id, name: "이름", bio: "소개", imageUrl: "https://example.net/photo.jpg" }]),
    );
    await expect(discoveryClient.profiles(signal)).rejects.toThrow(/id/);
  }
});

test("choices survive a reload and corrupt or inaccessible browser storage is safe", () => {
  expect(readChoices()).toEqual({});
  expect(saveChoices({ nari: true, bora: false })).toBe(true);
  expect(readChoices()).toEqual({ nari: true, bora: false });
  localStorage.setItem("ren-ai.discovery.choices", "not json");
  expect(readChoices()).toEqual({});
  localStorage.setItem("ren-ai.discovery.choices", '{"nari":"yes"}');
  expect(readChoices()).toEqual({});
  vi.stubGlobal("localStorage", {
    getItem: vi.fn<Storage["getItem"]>().mockImplementation(() => {
      throw new Error("storage blocked");
    }),
    setItem: vi.fn<Storage["setItem"]>().mockImplementation(() => {
      throw new Error("quota exceeded");
    }),
  });
  expect(readChoices()).toEqual({});
  expect(saveChoices({ nari: true })).toBe(false);
});

test("public deployment can call the configured API rather than the static site", async () => {
  vi.stubEnv("VITE_DISCOVERY_API_URL", "https://api-msg.hena.dev/");
  vi.resetModules();
  const { discoveryClient: deployed } = await import("./client.ts");
  const imageUrl = "/discovery/images/01234567-89ab-cdef-0123-456789abcdef.png";
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json([
      {
        id: "nari",
        name: "나리",
        bio: "공개 소개",
        imageUrl,
        portraits: { anime: imageUrl, photo: "https://photos.example.net/nari.jpg" },
      },
      {
        id: "legacy",
        name: "기존 인물",
        bio: "기존 공개 소개",
        imageUrl: "https://photos.example.net/legacy.jpg",
      },
      {
        id: "mixed",
        name: "다른 인물",
        bio: "공개 소개",
        imageUrl,
        portraits: { anime: "https://photos.example.net/mixed/", photo: imageUrl },
      },
    ]),
  );
  vi.stubGlobal("fetch", fetcher);
  const profiles = await deployed.profiles(new AbortController().signal);
  expect(profiles[0]?.imageUrl).toBe(`https://api-msg.hena.dev${imageUrl}`);
  expect(profiles[0]?.portraits).toEqual({
    anime: `https://api-msg.hena.dev${imageUrl}`,
    photo: "https://photos.example.net/nari.jpg",
  });
  expect(profiles[1]?.imageUrl).toBe("https://photos.example.net/legacy.jpg");
  expect(profiles[2]?.portraits).toEqual({
    anime: "https://photos.example.net/mixed/",
    photo: `https://api-msg.hena.dev${imageUrl}`,
  });
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://api-msg.hena.dev/discovery/personas");
  vi.unstubAllEnvs();
  vi.resetModules();
});

test("service-owned portraits use the local proxy while unsafe image paths stay rejected", async () => {
  vi.resetModules();
  const { discoveryClient: local } = await import("./client.ts");
  const imageUrl = "/discovery/images/01234567-89ab-cdef-0123-456789abcdef.webp";
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
    Response.json([
      {
        id: "nari",
        name: "나리",
        bio: "공개 소개",
        imageUrl,
        portraits: { anime: "https://photos.example.net/nari.jpg", photo: imageUrl },
      },
    ]),
  );
  vi.stubGlobal("fetch", fetcher);
  const localProfiles = await local.profiles(new AbortController().signal);
  expect(localProfiles[0]?.imageUrl).toBe(imageUrl);
  expect(localProfiles[0]?.portraits).toEqual({
    anime: "https://photos.example.net/nari.jpg",
    photo: imageUrl,
  });
  for (const unsafe of [
    "/images/private.png",
    "/discovery/images/../secret.png",
    "/discovery/images/01234567-89ab-cdef-0123-456789abcdef.svg",
    "//evil.example/image.png",
    "http://evil.example/discovery/images/01234567-89ab-cdef-0123-456789abcdef.png",
    "/prefix/discovery/images/01234567-89ab-cdef-0123-456789abcdef.png",
    "/discovery/images/01234567-89ab-cdef-0123-456789abcdef.png?private=1",
  ]) {
    fetcher.mockResolvedValueOnce(
      Response.json([{ id: "nari", name: "나리", bio: "공개 소개", imageUrl: unsafe }]),
    );
    await expect(local.profiles(new AbortController().signal)).rejects.toThrow(/imageUrl/);
  }
});

test("a malformed image pair cannot enter the browser catalog", async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  for (const portraits of [
    { anime: "https://example.net/anime.jpg" },
    { anime: "javascript:alert(1)", photo: "https://example.net/photo.jpg" },
    { anime: "https://example.net/anime.jpg", photo: "/private/photo.jpg" },
  ]) {
    fetcher.mockResolvedValueOnce(
      Response.json([
        {
          id: "nari",
          name: "나리",
          bio: "소개",
          imageUrl: "https://example.net/legacy.jpg",
          portraits,
        },
      ]),
    );
    await expect(discoveryClient.profiles(new AbortController().signal)).rejects.toThrow(
      /portraits/,
    );
  }
});
