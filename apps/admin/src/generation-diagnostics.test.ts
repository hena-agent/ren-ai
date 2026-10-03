import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { createProfileGenerator } from "./generation.ts";
import { character, png } from "../test/fixtures.ts";

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
const modelReply = (parts: object[], finishReason = "STOP") =>
  createProfileGenerator({
    key: "key",
    fetcher: async () =>
      Response.json({ candidates: [{ content: { parts }, finishReason }], promptFeedback: {} }),
  });

test("HTTP errors retain safe provider diagnostics and tolerate non-JSON error pages", async () => {
  const responses = [
    {
      response: Response.json(
        {
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            message: "key=secret-key\nprivate description",
          },
        },
        { status: 403 },
      ),
      fields: { status: 403, code: "403", providerStatus: "PERMISSION_DENIED" },
      message: "key=<REDACTED>\n<REDACTED>",
    },
    {
      response: new Response("<html>secret-key</html>", { status: 502 }),
      fields: { status: 502, code: "http_error" },
      message: "Profile generation failed",
    },
    {
      response: Response.json({ error: {} }, { status: 500 }),
      fields: { status: 500, code: "http_error" },
      message: "Profile generation failed",
    },
    {
      response: Response.json({ error: { status: "", message: "" } }, { status: 500 }),
      fields: { status: 500, code: "http_error" },
      message: "Profile generation failed",
    },
    {
      response: Response.json(
        { error: { code: "private", status: 42, message: { contents: "private" } } },
        { status: 502 },
      ),
      fields: { status: 502, code: "http_error" },
      message: "Profile generation failed",
    },
  ];
  for (const { response, fields, message } of responses) {
    const model = createProfileGenerator({
      key: "secret-key",
      imageModel: "image-model",
      fetcher: async () => response,
    });
    await expect(
      model.portrait({ name: "name", description: "private description" }, "photo"),
    ).rejects.toMatchObject({
      name: "GenerationError",
      message,
      fields: { model: "image-model", ...fields },
    });
  }
});

test("network failures distinguish timeout, abort, ordinary errors and non-Error throws", async () => {
  for (const [cause, code, message] of [
    [new DOMException("deadline exceeded", "TimeoutError"), "timeout", "deadline exceeded"],
    [new DOMException("cancelled", "AbortError"), "aborted", "cancelled"],
    [new Error("offline secret-key"), "network_error", "offline <REDACTED>"],
    ["raw secret-key", "network_error", "Generation network failure"],
  ]) {
    const model = createProfileGenerator({
      key: "secret-key",
      fetcher: async () => {
        throw cause;
      },
    });
    await expect(model.portrait(character, "anime")).rejects.toMatchObject({
      message,
      fields: { code, model: "gemini-3.1-flash-image" },
    });
  }
  const root = Object.assign(new Error("DNS unavailable"), { code: "ENOTFOUND" });
  const wrapped = new TypeError("fetch failed", { cause: root });
  await expect(
    createProfileGenerator({
      key: "key",
      fetcher: async () => {
        throw wrapped;
      },
    }).portrait(character, "photo"),
  ).rejects.toMatchObject({
    message: "DNS unavailable",
    fields: { code: "network_error", causeName: "Error", causeCode: "ENOTFOUND" },
    stack: root.stack,
  });
  const noStack = new Error("offline");
  delete noStack.stack;
  await expect(
    createProfileGenerator({
      key: "key",
      fetcher: async () => {
        throw noStack;
      },
    }).portrait(character, "photo"),
  ).rejects.toMatchObject({ message: "offline", fields: { causeName: "Error" } });
  await expect(
    createProfileGenerator({
      key: "key",
      fetcher: async () => {
        throw noStack;
      },
    }).portrait(character, "photo"),
  ).rejects.toHaveProperty("stack", expect.stringContaining("networkError"));
});

test("blocked, empty and invalid responses expose reasons without returning model output", async () => {
  for (const [body, fields, message] of [
    [
      { promptFeedback: { blockReason: "SAFETY" } },
      { code: "no_content", blockReason: "SAFETY" },
      "No generated content",
    ],
    [
      { candidates: [{ finishReason: "IMAGE_SAFETY" }] },
      { code: "no_content", finishReason: "IMAGE_SAFETY" },
      "No generated content",
    ],
    [
      {
        candidates: [
          { content: { parts: [{ text: "private model refusal" }] }, finishReason: "NO_IMAGE" },
        ],
      },
      { code: "no_image", finishReason: "NO_IMAGE" },
      "No generated portrait",
    ],
    [{ candidates: [] }, { code: "no_content" }, "No generated content"],
    [
      { candidates: [{ content: { parts: [{ text: 42 }] } }] },
      { code: "invalid_response" },
      "Invalid generation response",
    ],
    [
      {
        candidates: [{ content: { parts: [] } }],
        promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
      },
      { code: "no_content", blockReason: "PROHIBITED_CONTENT" },
      "No generated content",
    ],
    [
      { promptFeedback: { blockReason: 42 } },
      { code: "invalid_response" },
      "Invalid generation response",
    ],
  ]) {
    const model = createProfileGenerator({ key: "key", fetcher: async () => Response.json(body) });
    await expect(model.portrait(character, "anime")).rejects.toMatchObject({ message, fields });
  }
  await expect(
    createProfileGenerator({
      key: "key",
      fetcher: async () => new Response("invalid JSON"),
    }).portrait(character, "photo"),
  ).rejects.toMatchObject({ fields: { code: "invalid_response" } });
});

test("validation failures are payload-free and valid responses can carry completion metadata", async () => {
  await expect(
    modelReply([{ text: "private malformed JSON" }]).character("idea"),
  ).rejects.toMatchObject({
    message: "Invalid character draft",
    fields: { code: "invalid_character", finishReason: "STOP" },
  });
  await expect(
    modelReply([{ text: "x".repeat(241) }]).introduction(character),
  ).rejects.toMatchObject({
    fields: { code: "invalid_introduction", finishReason: "STOP" },
  });
  await expect(
    modelReply([{ inlineData: { mimeType: "image/png", data: "%%%" } }]).portrait(
      character,
      "photo",
    ),
  ).rejects.toMatchObject({ fields: { code: "invalid_encoding", finishReason: "STOP" } });
  expect(
    await modelReply(
      [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }],
      "",
    ).portrait(character, "photo"),
  ).toEqual({ bytes: png, mimeType: "image/png" });
  await expect(createProfileGenerator({ key: " " }).character("idea")).rejects.toMatchObject({
    fields: { code: "missing_key", model: "gemini-3.8-flash" },
  });
});
