import { afterEach, expect, test, vi } from "vitest";
import { createProfileGenerator } from "./generation.ts";
import { character, introduction, png } from "../test/fixtures.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const reply = (parts: object[]) => Response.json({ candidates: [{ content: { parts } }] });

test("the Gemini adapter sends the complete character to text and portrait models with server-only authentication", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      reply([{ thought: true, text: "private reasoning" }, { text: introduction }]),
    )
    .mockResolvedValueOnce(
      reply([
        {
          thought: true,
          inlineData: { mimeType: "image/png", data: Buffer.from("hidden").toString("base64") },
        },
        { text: "Here is the portrait." },
        { inlineData: { mimeType: "image/png", data: png.toString("base64") } },
      ]),
    );
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const client = createProfileGenerator({
    key: "test-key",
    endpoint: "https://model.test/v1beta",
    textModel: "text/model",
    imageModel: "portrait/model",
    fetcher,
  });
  expect(await client.introduction(character)).toBe(introduction);
  expect(await client.portrait(character, "photo")).toEqual({ bytes: png, mimeType: "image/png" });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "https://model.test/v1beta/models/text%2Fmodel:generateContent",
    "https://model.test/v1beta/models/portrait%2Fmodel:generateContent",
  ]);
  for (const [url, init] of fetcher.mock.calls) {
    const request = new Request(url, init);
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-goog-api-key")).toBe("test-key");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.url).not.toContain("test-key");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = await request.text();
    expect(body).toContain(character.name);
    expect(body).toContain("비공개 설정");
    expect(body).toContain("contents");
  }
  expect(timeout).toHaveBeenCalledWith(120_000);
  const introductionBody = await new Request(...fetcher.mock.calls[0]!).text();
  expect(introductionBody).not.toContain("responseMimeType");
  expect(JSON.parse(introductionBody)).toMatchObject({
    generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "LOW" } },
    contents: [{ role: "user" }],
  });
  expect(await new Request(...fetcher.mock.calls[1]!).json()).toMatchObject({
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "4:5", imageSize: "1K" },
    },
  });
});

test("default model configuration uses the native fetch adapter and joins visible text parts only", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      reply([
        { text: "  첫 문장. " },
        { inlineData: { mimeType: "image/jpeg", data: "" } },
        { text: "다음 문장.  " },
      ]),
    )
    .mockResolvedValueOnce(
      reply([{ inlineData: { mimeType: "image/webp", data: png.toString("base64") } }]),
    );
  vi.stubGlobal("fetch", fetcher);
  const client = createProfileGenerator({ key: "key" });
  expect(await client.introduction(character)).toBe("첫 문장. 다음 문장.");
  expect((await client.portrait(character, "photo")).mimeType).toBe("image/webp");
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
  );
  expect(fetcher.mock.calls[1]?.[0]).toBe(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent",
  );
});

test("missing credentials, provider outages, refusals and malformed content never become a profile", async () => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(
    createProfileGenerator({ key: " ", fetcher }).introduction(character),
  ).rejects.toThrow("GEMINI_API_KEY");
  expect(fetcher).not.toHaveBeenCalled();
  const bad = [
    Response.json(
      { candidates: [{ content: { parts: [{ text: introduction }] } }] },
      { status: 429 },
    ),
    Response.json({}),
    Response.json({ candidates: [] }),
    Response.json({ candidates: [{ content: { parts: [{ text: 12 }] } }] }),
    Response.json({ candidates: [{ content: { parts: [{ thought: "yes", text: "wrong" }] } }] }),
    reply([]),
    reply([{ text: " " }]),
    reply([{ text: "x".repeat(241) }]),
  ];
  for (const response of bad) {
    await expect(
      createProfileGenerator({ key: "key", fetcher: async () => response }).introduction(character),
    ).rejects.toThrow(
      /Profile generation failed|No generated content|Invalid generation response|Invalid introduction/,
    );
  }
  for (const parts of [
    [],
    [{ text: "No portrait" }],
    [{ inlineData: { mimeType: "image/svg+xml", data: "PHN2Zz4=" } }],
    [{ inlineData: { mimeType: "image/png", data: "%%%" } }],
  ]) {
    await expect(
      createProfileGenerator({ key: "key", fetcher: async () => reply(parts) }).portrait(
        character,
        "photo",
      ),
    ).rejects.toThrow(
      /No generated portrait|Invalid generation response|Invalid portrait encoding/,
    );
  }
  await expect(
    createProfileGenerator({
      key: "key",
      fetcher: async () => {
        throw new Error("offline");
      },
    }).portrait(character, "photo"),
  ).rejects.toThrow("offline");
});

test("an introduction at the public-profile limit remains valid", async () => {
  const text = "가".repeat(240);
  const client = createProfileGenerator({ key: "key", fetcher: async () => reply([{ text }]) });
  expect(await client.introduction(character)).toBe(text);
});
