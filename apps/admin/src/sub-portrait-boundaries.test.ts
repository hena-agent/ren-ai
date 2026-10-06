import { expect, test, vi } from "vitest";
import { createProfileGenerator } from "./generation.ts";
import { draftTokens } from "./draft.ts";
import { character, fixture, generator, legacy, request, tokenOf } from "../test/fixtures.ts";
import { basePreview, preview, subGenerator } from "../test/sub-portraits.ts";

test("a single secondary failure preserves images and emits correlated diagnostics without leaking the idea, optional prompt or reference", async () => {
  const key = "private provider key";
  const provider = createProfileGenerator({
    key,
    imageModel: "test-image-model",
    fetcher: async () =>
      Response.json(
        {
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: `${key} private photo idea private tweak`,
          },
        },
        { status: 429 },
      ),
  });
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, logs } = await basePreview({ ...subGenerator, portrait });
  portrait.mockImplementation(provider.portrait);
  const failed = await admin(
    request("/personas?style=photo", {
      ...character,
      draft: tokenOf(page),
      intent: "subportrait",
      imageDirection: "private photo idea",
      portraitInstructions: "private tweak",
    }),
  );
  expect(failed.status).toBe(503);
  const retained = await failed.text();
  expect(preview(retained)).toEqual(preview(page));
  expect(draftTokens("test-password").decode(tokenOf(retained)).imageInstructions).toBe(
    "private tweak",
  );
  expect(logs.filter((entry) => entry.event === "operation.failed")).toHaveLength(1);
  expect(logs.find((entry) => entry.event === "operation.failed")).toMatchObject({
    requestId: failed.headers.get("x-request-id"),
    stage: "generation.api",
    style: "photo",
    poseIndex: 1,
    code: "429",
    status: 429,
    model: "test-image-model",
  });
  for (const secret of [key, "private photo idea", "private tweak", character.description])
    expect(JSON.stringify(logs)).not.toContain(secret);
  portrait.mockImplementation(subGenerator.portrait);
  const retried = await admin(
    request("/personas?style=photo", {
      ...character,
      draft: tokenOf(retained),
      intent: "subportrait",
      imageDirection: "private photo idea",
      portraitInstructions: "",
    }),
  );
  expect(retried.status).toBe(200);
  expect(preview(await retried.text()).secondaryPortraits).toHaveLength(1);
});

test("manual addition requires no planner or saved configuration", async () => {
  const { admin, page } = await basePreview(generator);
  const manual = await admin(
    request("/personas?style=anime", {
      ...character,
      draft: tokenOf(page),
      intent: "subportrait",
      portraitInstructions: "a selfie",
    }),
  );
  expect(manual.status).toBe(200);
  expect(preview(await manual.text()).secondaryPortraits?.[0]?.style).toBe("anime");
});

test("a missing style can create a main image while external references and invalid styles remain rejected", async () => {
  const { admin, store } = await fixture(subGenerator);
  await store.create({ ...legacy, ...character });
  const path = `/personas/${legacy.id}`;
  const page = await (await admin(request(path))).text();
  expect(
    (
      await admin(
        request(`${path}?style=anime`, {
          ...character,
          draft: tokenOf(page),
          intent: "subportrait",
        }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await admin(
        request(`${path}?style=photo`, {
          ...character,
          draft: tokenOf(page),
          intent: "subportrait",
        }),
      )
    ).status,
  ).toBe(400);
  const basePortrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const base = await basePreview({ ...subGenerator, portrait: basePortrait });
  for (const style of ["", "other", "__proto__"])
    expect(
      (
        await base.admin(
          request(`/personas?style=${style}`, {
            ...character,
            draft: tokenOf(base.page),
            intent: "subportrait",
          }),
        )
      ).status,
    ).toBe(400);
  expect(basePortrait).toHaveBeenCalledTimes(2);
});

test("parallel independent additions are serialized before a second paid request", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page } = await basePreview({ ...subGenerator, portrait });
  let resolve = vi.fn<(value: Awaited<ReturnType<typeof generator.portrait>>) => void>();
  const image = new Promise<Awaited<ReturnType<typeof generator.portrait>>>((done) => {
    resolve = vi.fn<(value: Awaited<ReturnType<typeof generator.portrait>>) => void>(done);
  });
  portrait.mockReturnValue(image);
  const fields = { ...character, draft: tokenOf(page), intent: "subportrait" };
  const first = admin(request("/personas?style=photo", fields));
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(3));
  const second = admin(request("/personas?style=anime", fields));
  expect(portrait).toHaveBeenCalledTimes(3);
  resolve({ bytes: Buffer.from("ffd8ffe0", "hex"), mimeType: "image/jpeg" });
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
  expect(portrait).toHaveBeenCalledTimes(4);
});
