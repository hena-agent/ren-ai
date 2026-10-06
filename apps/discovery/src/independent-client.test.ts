import { afterEach, expect, test, vi } from "vitest";
import { discoveryClient } from "./client.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
test("service-owned independent main and additional photos are resolved individually at the public API boundary", async () => {
  vi.stubEnv("VITE_DISCOVERY_API_URL", "https://api.example.net");
  const main = "/discovery/images/01234567-89ab-cdef-0123-456789abcdef.jpg";
  const extra = "/discovery/images/11234567-89ab-cdef-0123-456789abcdef.png";
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(
      Response.json([
        {
          id: "self",
          name: "자기",
          bio: "소개",
          imageUrl: main,
          portraits: { photo: main },
          secondaryPortraits: [{ style: "photo", imageUrl: extra }],
          privatePrompt: "private",
        },
      ]),
    ),
  );
  const people = await discoveryClient.profiles(new AbortController().signal);
  expect(people[0]?.portraits).toEqual({ photo: `https://api.example.net${main}` });
  expect(people[0]?.secondaryPortraits).toEqual([
    { style: "photo", imageUrl: `https://api.example.net${extra}` },
  ]);
  expect(people[0]).not.toHaveProperty("privatePrompt");
});

test("partial main styles are allowed but unsafe, missing and invalid-style independent photos are rejected", async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  const profile = {
    id: "valid",
    name: "인물",
    bio: "소개",
    imageUrl: "https://example.net/main.jpg",
  };
  for (const secondaryPortraits of [
    [{ style: "photo" }],
    [{ style: "unknown", imageUrl: profile.imageUrl }],
    [{ style: "photo", imageUrl: "javascript:alert(1)" }],
    Array.from({ length: 11 }, () => ({ style: "photo", imageUrl: profile.imageUrl })),
  ]) {
    fetcher.mockResolvedValueOnce(Response.json([{ ...profile, secondaryPortraits }]));
    await expect(discoveryClient.profiles(new AbortController().signal)).rejects.toThrow(
      /secondaryPortraits/,
    );
  }
});
