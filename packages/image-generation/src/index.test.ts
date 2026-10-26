import { expect, test, vi } from "vitest";
import { codexImage, ImageGenerationError } from "./index.ts";

test.each(["1024x1536", "1536x1024"] as const)(
  "standalone callers can request a %s JPEG with an identity reference",
  async (size) => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ b64_json: bytes.toString("base64") }] }));
    expect(
      await codexImage({
        key: "private-key",
        prompt: "private direction",
        references: [{ bytes, mimeType: "image/jpeg" }],
        size,
        outputFormat: "jpeg",
        fetcher,
      }),
    ).toEqual({ bytes, mimeType: "image/jpeg" });
    const request = new Request(...fetcher.mock.calls[0]!);
    expect(request.url).toBe("https://codex-image.renai.im/v1/images/edits");
    expect(await request.json()).toEqual({
      model: "gpt-image-2.5",
      prompt: "private direction",
      n: 1,
      size,
      response_format: "b64_json",
      output_format: "jpeg",
      image: ["data:image/jpeg;base64,/9j/2Q=="],
      input_fidelity: "high",
    });
  },
);

test("standalone provider errors expose bounded diagnostics without input secrets or extra payload fields", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json(
      {
        error: {
          message: `private-key second private line data:image/png;base64,AQID ${"x".repeat(1500)}`,
          code: "overloaded private-key",
          type: "upstream_error AQID",
          prompt: "unregistered private response payload",
        },
      },
      { status: 503 },
    ),
  );
  const [result] = await Promise.allSettled([
    codexImage({
      key: "private-key",
      prompt: "first private line\nsecond private line",
      references: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }],
      size: "1024x1280",
      outputFormat: "png",
      fetcher,
    }),
  ]);
  expect(result).toMatchObject({
    status: "rejected",
    reason: {
      fields: {
        model: "gpt-image-2.5",
        status: 503,
        code: "overloaded <REDACTED>",
        providerStatus: "upstream_error <REDACTED>",
      },
    },
  });
  if (result.status !== "rejected" || !(result.reason instanceof ImageGenerationError))
    throw new Error("Expected a provider failure");
  expect(result.reason.message).toHaveLength(1000);
  const diagnostic = JSON.stringify(result);
  for (const secret of ["private-key", "private line", "AQID", "unregistered"])
    expect(diagnostic).not.toContain(secret);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
