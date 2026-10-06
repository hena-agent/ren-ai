import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { character, femaleCharacter, generator, request, tokenOf } from "../test/fixtures.ts";
import { basePreview, subGenerator, preview } from "../test/sub-portraits.ts";
import { draftTokens } from "./draft.ts";
import { readPortraitReference } from "./portrait-images.ts";

test("single-style addition accepts exactly 20MB and WebP identity reference bytes", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, store } = await basePreview({ ...subGenerator, portrait });
  for (const [bytes, mimeType] of [
    [Buffer.alloc(20_000_000), "image/png"],
    [Buffer.from("524946460400000057454250", "hex"), "image/webp"],
  ] as const) {
    const read = vi
      .spyOn(store, "image")
      .mockImplementation(
        async () => new Response(new Uint8Array(bytes), { headers: { "content-type": mimeType } }),
      );
    expect(
      (
        await admin(
          request("/personas?style=photo", {
            ...character,
            draft: tokenOf(page),
            intent: "subportrait",
            portraitInstructions: mimeType,
          }),
        )
      ).status,
    ).toBe(200);
    const call = portrait.mock.calls.at(-1)!;
    expect(call[0]).toEqual(femaleCharacter);
    expect(call[1]).toBe("photo");
    expect(call[3]?.mimeType).toBe(mimeType);
    expect(call[3]?.bytes.byteLength).toBe(bytes.byteLength);
    expect(createHash("sha256").update(call[3]!.bytes).digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    read.mockRestore();
  }
});

test("reference failures diagnose cause, style and request without echoed payloads", async () => {
  const { admin, page, store, logs } = await basePreview();
  for (const [response, code, message] of [
    [new Response(null, { status: 404 }), "reference_unavailable", "Base portrait unavailable"],
    [
      new Response(new Uint8Array(20_000_001), { headers: { "content-type": "image/png" } }),
      "invalid_reference",
      "Base portrait too large",
    ],
    [
      new Response("bytes", { headers: { "content-type": "private malformed type" } }),
      "invalid_reference",
      "Invalid base portrait type",
    ],
  ] as const) {
    const read = vi.spyOn(store, "image").mockImplementation(async () => response.clone());
    const failed = await admin(
      request("/personas?style=photo", {
        ...character,
        draft: tokenOf(page),
        intent: "subportrait",
      }),
    );
    expect(failed.status).toBe(503);
    expect(
      logs.find(
        (entry) =>
          entry.requestId === failed.headers.get("x-request-id") &&
          entry.event === "operation.failed",
      ),
    ).toMatchObject({ stage: "portrait.reference.read", code, style: "photo", error: { message } });
    expect(JSON.stringify(logs)).not.toContain("private malformed type");
    read.mockRestore();
  }
});

test("the reference boundary never fetches outside URLs even when called independently of batch validation", async () => {
  const { store } = await basePreview();
  const read = vi.spyOn(store, "image");
  await expect(
    readPortraitReference("https://outside.example/image.jpg", "photo", store),
  ).rejects.toMatchObject({ kind: "invalid" });
  expect(read).not.toHaveBeenCalled();
});

test("style-specific capacity blocks an extra image before any generation and leaves the other style available", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, store } = await basePreview({ ...subGenerator, portrait });
  const record = preview(page);
  await store.create({
    ...record,
    secondaryPortraits: Array.from({ length: 5 }, (_, index) => ({
      style: "photo",
      imageUrl: `https://example.net/${index}.jpg`,
    })),
  });
  const route = `/personas/${record.id}`;
  const editing = await (await admin(request(route))).text();
  expect(
    (
      await admin(
        request(`${route}?style=photo`, {
          ...character,
          draft: tokenOf(editing),
          intent: "subportrait",
        }),
      )
    ).status,
  ).toBe(400);
  expect(portrait).toHaveBeenCalledTimes(2);
  const after = await admin(
    request(`${route}?style=anime`, {
      ...character,
      draft: tokenOf(editing),
      intent: "subportrait",
    }),
  );
  expect(after.status).toBe(200);
  expect(draftTokens("test-password").decode(tokenOf(await after.text()))).not.toHaveProperty(
    "recommendation",
  );
});
