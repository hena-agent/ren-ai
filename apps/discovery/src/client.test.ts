import { afterEach, expect, test, vi } from "vitest";
import { discoveryNotice, discoveryNotices, DiscoveryFailure } from "@ren-ai/onboarding";
import {
  discoveryClient,
  BrowseExpiredError,
  RegistrationError,
  loadDiscoveryNotices,
} from "./client.ts";
import { readChoices, saveChoices } from "./choices.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.unstubAllEnvs();
});

test("activity uses keep-alive delivery, returns Visit country and rejects an unavailable endpoint", async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  const report = {
    step: "visit",
    source: { entry: "home", referrer: "", source: "", medium: "", campaign: "" },
    device: "phone",
    locale: "ko",
    imageStyle: "anime",
  } as const;
  fetcher.mockResolvedValueOnce(
    new Response(null, { status: 204, headers: { "X-Visit-Country": "KR" } }),
  );
  expect(await discoveryClient.activity(report)).toBe("KR");
  expect(fetcher).toHaveBeenLastCalledWith("/discovery/activity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
    keepalive: true,
  });
  fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
  await expect(discoveryClient.activity(report)).rejects.toThrow("Activity unavailable");
});

test("only explicit expired-cursor errors restart browsing; authorization and other failures remain failures", async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  for (const [status, code, cursor] of [
    [400, "personas", "old"],
    [400, "reselection", "old"],
    [400, "personas", undefined],
    [503, "personas", "old"],
  ] as const) {
    fetcher.mockResolvedValueOnce(Response.json(code, { status }));
    const result = discoveryClient.browse(
      { locale: "ko", ...(cursor && { cursor }) },
      signal,
      "a".repeat(64),
    );
    await expect(result).rejects.toThrow(
      cursor && status === 400 && code === "personas" ? BrowseExpiredError : "Profiles unavailable",
    );
  }
  fetcher.mockResolvedValueOnce(Response.json({ people: [], nextCursor: null }));
  expect(await discoveryClient.browse({ locale: "en", cursor: "next" }, signal)).toEqual({
    people: [],
    nextCursor: null,
  });
  expect(fetcher.mock.lastCall?.[0]).toBe("/discovery/personas?locale=en&cursor=next");
});

test("restoring many Likes uses bounded ID requests and preserves the private reselection scope", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json([]));
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  expect(await discoveryClient.profiles(signal, undefined, [])).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
  const ids = Array.from({ length: 201 }, (_, i) => `p${i}`);
  const reselectionToken = "b".repeat(64);
  expect(await discoveryClient.profiles(signal, reselectionToken, ids)).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (let index = 0; index < 3; index++) {
    expect(fetcher.mock.calls[index]![0]).toBe("/discovery/profiles");
    expect(fetcher.mock.calls[index]![1]?.body).toBe(
      JSON.stringify({ ids: ids.slice(index * 100, (index + 1) * 100), reselectionToken }),
    );
  }
});

test("registration errors allowlist server codes, safe correlation IDs and bounded retry deadlines", async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  const request = {
    handle: "+821012345678",
    locale: "ko",
    privacyNoticeVersion: discoveryNotice.version,
    likedPersonaIDs: ["nari"],
    turnstileToken: "human",
    name: "Visitor",
  } as const;
  const requestId = crypto.randomUUID();
  for (const code of DiscoveryFailure.literals) {
    fetcher.mockResolvedValueOnce(
      Response.json(code, {
        status: code === "try_later" ? 429 : 400,
        headers: { "X-Request-ID": requestId, "Retry-After": "60" },
      }),
    );
    const result = discoveryClient.join(request);
    await expect(result).rejects.toBeInstanceOf(RegistrationError);
    await expect(result).rejects.toMatchObject({ code, requestId });
  }
  vi.spyOn(Date, "now").mockReturnValue(1000);
  fetcher.mockResolvedValueOnce(
    Response.json("try_later", { status: 429, headers: { "Retry-After": "60" } }),
  );
  await expect(discoveryClient.join(request)).rejects.toMatchObject({ retryAt: 61_000 });
  for (const retry of ["0", "-1", "1.5", "3601", "not-a-number"]) {
    fetcher.mockResolvedValueOnce(
      Response.json("try_later", {
        status: 429,
        headers: { "Retry-After": retry, "X-Request-ID": "private input" },
      }),
    );
    await expect(discoveryClient.join(request)).rejects.toMatchObject({
      code: "try_later",
      requestId: undefined,
      retryAt: undefined,
    });
  }
  fetcher.mockResolvedValueOnce(new Response("private upstream input", { status: 502 }));
  await expect(discoveryClient.join(request)).rejects.toMatchObject({
    code: "registration",
    message: "Registration unavailable",
  });
});

test("the latest notices load without caching, and failed or malformed responses are rejected", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(discoveryNotices));
  vi.stubGlobal("fetch", fetcher);
  expect(await loadDiscoveryNotices()).toEqual(discoveryNotices);
  expect(fetcher).toHaveBeenCalledWith("/discovery/notices", { cache: "no-store" });
  fetcher.mockResolvedValueOnce(Response.json("storage", { status: 503 }));
  await expect(loadDiscoveryNotices()).rejects.toMatchObject({ code: "storage" });
  fetcher.mockResolvedValueOnce(Response.json({}));
  await expect(loadDiscoveryNotices()).rejects.toThrow(/ko/);
});

test("the browser validates structured profiles, discards Markdown payloads and accepts the deployed older shape", async () => {
  const persona = { id: "first", name: "하린", bio: "소개", imageUrl: "" };
  const profile = {
    introduction: "내가 쓴 소개예요.",
    sections: [{ type: "interests", title: "관심사", items: ["재즈"] }],
  };
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  fetcher.mockResolvedValueOnce(
    Response.json([{ ...persona, profile, publicProfile: "obsolete Markdown", prompt: "private" }]),
  );
  expect(await discoveryClient.profiles(signal, undefined, [persona.id])).toEqual([
    { ...persona, profile },
  ]);
  fetcher.mockResolvedValueOnce(
    Response.json([{ ...persona, publicProfile: "old public Markdown" }]),
  );
  expect(await discoveryClient.profiles(signal, undefined, [persona.id])).toEqual([persona]);
  for (const sections of [
    [{ type: "interests", title: "관심사", items: "재즈" }],
    [{ type: "prompt", question: "질문", answer: "" }],
    [{ type: "html", body: "<script>bad()</script>" }],
  ]) {
    fetcher.mockResolvedValueOnce(
      Response.json([{ ...persona, profile: { ...profile, sections } }]),
    );
    await expect(discoveryClient.profiles(signal, undefined, [persona.id])).rejects.toThrow(
      /profile/,
    );
  }
});

test("a later profile read requests api-app again and includes newly published personas", async () => {
  const profile = { id: "first", name: "First", bio: "Public profile", imageUrl: "" };
  const added = { ...profile, id: "added", name: "Added" };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([profile]))
    .mockResolvedValueOnce(Response.json([profile, added]));
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  expect(await discoveryClient.profiles(signal, undefined, [profile.id, added.id])).toEqual([
    profile,
  ]);
  expect(await discoveryClient.profiles(signal, undefined, [profile.id, added.id])).toEqual([
    profile,
    added,
  ]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenLastCalledWith(
    "/discovery/profiles",
    expect.objectContaining({ signal, body: JSON.stringify({ ids: [profile.id, added.id] }) }),
  );
});

test.each(["", "invalid", "a".repeat(64)])(
  "an unusable reselection token fails safely without falling back to the public Catalog (%s)",
  async (reselectionToken) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("private upstream details", { status: 400 }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    await expect(
      discoveryClient.browse({ locale: "ko" }, signal, reselectionToken),
    ).rejects.toThrow("Profiles unavailable");
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/discovery/reselection/personas", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ locale: "ko", reselectionToken }),
      signal,
      cache: "no-store",
    });
  },
);

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
  expect(await discoveryClient.profiles(signal, undefined, ["nari"])).toEqual([
    {
      id: "nari",
      name: "나리",
      bio: "책 읽는 오후를 좋아해요.",
      imageUrl: "https://example.net/nari.jpg",
    },
  ]);
  expect(fetcher).toHaveBeenCalledWith("/discovery/profiles", expect.objectContaining({ signal }));
  const request = {
    handle: "+821012345678",
    locale: "ko",
    privacyNoticeVersion: discoveryNotice.version,
    likedPersonaIDs: ["nari"],
    turnstileToken: "verified",
    name: "Visitor",
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
  await expect(discoveryClient.profiles(signal, undefined, ["nari"])).rejects.toThrow(
    "Profiles unavailable",
  );
  fetcher.mockResolvedValueOnce(new Response(null, { status: 400 }));
  await expect(discoveryClient.join(request)).rejects.toThrow("Registration unavailable");
  fetcher.mockResolvedValueOnce(Response.json("reselection", { status: 400 }));
  await expect(discoveryClient.join(request)).rejects.toMatchObject({ code: "reselection" });
  fetcher.mockResolvedValueOnce(Response.json({ status: "sent" }));
  await expect(discoveryClient.join(request)).rejects.toThrow(/status/);
  fetcher.mockResolvedValueOnce(
    Response.json([{ id: "bad", name: "잘못된 이미지", bio: "", imageUrl: "javascript:alert(1)" }]),
  );
  await expect(discoveryClient.profiles(signal, undefined, ["bad"])).rejects.toThrow(
    /bio|imageUrl/,
  );
  for (const imageUrl of ["http://example.net/photo.jpg", "not-a-url", "javascript:alert(1)"]) {
    fetcher.mockResolvedValueOnce(
      Response.json([{ id: "valid", name: "이름", bio: "소개", imageUrl }]),
    );
    await expect(discoveryClient.profiles(signal, undefined, ["bad"])).rejects.toThrow(/imageUrl/);
  }
  for (const id of ["../escape", "ends/", "a".repeat(65)]) {
    fetcher.mockResolvedValueOnce(
      Response.json([{ id, name: "이름", bio: "소개", imageUrl: "https://example.net/photo.jpg" }]),
    );
    await expect(discoveryClient.profiles(signal, undefined, ["bad"])).rejects.toThrow(/id/);
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

test("profiles and registration use api-app while portraits retain their catalog origin", async () => {
  vi.stubEnv("VITE_DISCOVERY_API_URL", "https://api.renai.im/");
  vi.resetModules();
  const { discoveryClient: deployed } = await import("./client.ts");
  const imageUrl =
    "https://admin.renai.im/discovery/images/01234567-89ab-cdef-0123-456789abcdef.png";
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json([
      {
        id: "nari",
        name: "나리",
        bio: "공개 소개",
        imageUrl,
        portraits: { anime: imageUrl, photo: "https://photos.example.net/nari.jpg" },
        portraitGallery: [
          { anime: imageUrl, photo: "https://photos.example.net/nari.jpg" },
          { anime: "https://photos.example.net/another.jpg", photo: imageUrl },
        ],
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
  const profiles = await deployed.profiles(new AbortController().signal, undefined, [
    "nari",
    "legacy",
    "mixed",
  ]);
  expect(profiles[0]?.imageUrl).toBe(imageUrl);
  expect(profiles[0]?.portraits).toEqual({
    anime: imageUrl,
    photo: "https://photos.example.net/nari.jpg",
  });
  expect(profiles[1]?.imageUrl).toBe("https://photos.example.net/legacy.jpg");
  expect(profiles[0]?.portraitGallery).toEqual([
    { anime: imageUrl, photo: "https://photos.example.net/nari.jpg" },
    {
      anime: "https://photos.example.net/another.jpg",
      photo: imageUrl,
    },
  ]);
  expect(profiles[2]?.portraits).toEqual({
    anime: "https://photos.example.net/mixed/",
    photo: imageUrl,
  });
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.renai.im/discovery/profiles");
  fetcher.mockResolvedValueOnce(Response.json({ status: "waiting" }));
  expect(
    await deployed.join({
      handle: "+821012345678",
      locale: "ko",
      privacyNoticeVersion: discoveryNotice.version,
      likedPersonaIDs: ["nari"],
      turnstileToken: "verified",
      name: "Visitor",
    }),
  ).toEqual({ status: "waiting" });
  expect(fetcher.mock.calls[1]?.[0]).toBe("https://api.renai.im/discovery/waitlist");
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
  const localProfiles = await local.profiles(new AbortController().signal, undefined, ["nari"]);
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
    await expect(local.profiles(new AbortController().signal, undefined, ["nari"])).rejects.toThrow(
      /imageUrl/,
    );
  }
});

test("a malformed image pair cannot enter the browser catalog", async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  for (const portraits of [
    {},
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
    await expect(
      discoveryClient.profiles(new AbortController().signal, undefined, ["nari"]),
    ).rejects.toThrow(/portraits/);
  }
});
