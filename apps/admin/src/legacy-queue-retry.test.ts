import { expect, test, vi } from "vitest";
import { character, fixture, generator, newToken, request, tokenOf } from "../test/fixtures.ts";
import { preview, subGenerator } from "../test/sub-portraits.ts";
import { deferred, queuedRequest, jobUrl, finishedJob } from "../test/queue.ts";
import { createImageBatch } from "./image-batch.ts";
import { serializePersona } from "@ren-ai/personas";
import { savedPreview } from "../test/sub-portraits.ts";
import type { Mock } from "vitest";
import type { createAdmin } from "./admin.ts";
import { imageSlots } from "./image-slots.ts";

async function blockOtherPersona(
  admin: ReturnType<typeof createAdmin>,
  portrait: Mock<typeof generator.portrait>,
) {
  const wait = deferred<Awaited<ReturnType<typeof generator.portrait>>>();
  portrait.mockReturnValueOnce(wait.promise);
  const other = await admin(
    queuedRequest("/personas", {
      ...character,
      name: "Second",
      draft: await newToken(admin),
      intent: "generate",
    }),
  );
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(3));
  return { wait, other };
}

test("legacy retry processes blocked dependents after their failed main and restores per-photo directions on a repeated failure", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin } = await fixture({ ...subGenerator, portrait });
  portrait.mockRejectedValueOnce(new Error("main failure"));
  const fields = {
    ...character,
    draft: await newToken(admin),
    intent: "generate",
    imageCount: "2",
    portraitInstructions: "operator direction",
  };
  const first = await admin(request("/personas", fields));
  expect(first.status).toBe(503);
  expect(portrait).toHaveBeenCalledTimes(3);
  const completed = await admin(request("/personas", fields));
  expect(completed.status).toBe(200);
  expect(preview(await completed.text()).secondaryPortraits).toHaveLength(2);
  expect(portrait).toHaveBeenCalledTimes(5);
  const nextFields = { ...fields, draft: await newToken(admin) };
  portrait.mockRejectedValueOnce(new Error("first repeated"));
  expect((await admin(request("/personas", nextFields))).status).toBe(503);
  portrait.mockRejectedValueOnce(new Error("second repeated"));
  const failed = await admin(request("/personas", nextFields));
  expect(failed.status).toBe(503);
  const { draftTokens } = await import("./draft.ts");
  const draft = draftTokens("test-password").decode(tokenOf(await failed.text()));
  expect(draft.imagePrompts).toHaveLength(4);
  expect(draft.imagePrompts?.[0]).toBe("operator direction");
  expect(draft.imagePrompts?.[2]).toContain("PHOTO DIRECTION");
});

test("a confirmed retry waiting behind another persona resets its previous attempt timing and uses the new FIFO position", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin } = await fixture({ ...subGenerator, portrait });
  portrait.mockRejectedValueOnce(new Error("first main"));
  const first = await admin(
    queuedRequest("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  const path = jobUrl(first);
  const failed = await finishedJob(admin, path);
  const { wait, other } = await blockOtherPersona(admin, portrait);
  expect(
    (
      await admin(
        queuedRequest(`${path}/retry?image=0`, {
          ...character,
          draft: tokenOf(failed),
          portraitInstructions: "retry one",
        }),
      )
    ).status,
  ).toBe(303);
  const current = await (await admin(request(path))).text();
  expect(current).toContain("2번째");
  expect(current).toContain('data-state="waiting"');
  expect(current).not.toContain("실패 ·");
  wait.resolve({ bytes: Buffer.from("89504e470d0a1a0a", "hex"), mimeType: "image/png" });
  await finishedJob(admin, jobUrl(other));
  await finishedJob(admin, path);
  expect(portrait).toHaveBeenCalledTimes(5);
});

test("blank default prompts remain valid strings for initial main slots and receive variety only for extra photos", async () => {
  const { original, store } = await savedPreview();
  const draft = {
    id: original.id,
    base: serializePersona(original),
    preview: serializePersona(original),
    imageCount: 2,
    imagePrompts: ["", "", "", ""],
  };
  const batch = createImageBatch(
    original,
    draft,
    "generate",
    new URLSearchParams(),
    "generate",
    subGenerator,
    store,
  );
  expect(batch.prompts.slice(0, 2)).toEqual(["", ""]);
  expect(
    batch.prompts.slice(2).every((prompt) => typeof prompt === "string" && prompt.length > 30),
  ).toBe(true);
});

test("a legacy failed-batch replay shows queued status while another persona is running", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin } = await fixture({ ...subGenerator, portrait });
  portrait.mockRejectedValueOnce(new Error("first failed main"));
  const fields = { ...character, draft: await newToken(admin), intent: "generate" };
  const initial = await admin(queuedRequest("/personas", fields));
  const path = jobUrl(initial);
  await finishedJob(admin, path);
  const { wait, other } = await blockOtherPersona(admin, portrait);
  const replay = admin(request("/personas", fields));
  await vi.waitFor(async () => {
    const progress = await (await admin(request(path))).text();
    expect(progress).toContain('data-job-active="true"');
    expect(progress).toContain("2번째");
  });
  wait.resolve({ bytes: Buffer.from("89504e470d0a1a0a", "hex"), mimeType: "image/png" });
  await finishedJob(admin, jobUrl(other));
  expect((await replay).status).toBe(200);
  expect(portrait).toHaveBeenCalledTimes(5);
});

test("legacy multi-photo initial requests leave both main directions unmodified and default additions to photo", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin } = await fixture({ ...subGenerator, portrait });
  const response = await admin(
    request("/personas", {
      ...character,
      draft: await newToken(admin),
      intent: "generate",
      imageCount: "2",
      portraitInstructions: "operator main direction",
    }),
  );
  expect(response.status).toBe(200);
  expect(portrait.mock.calls.slice(0, 2).map((call) => call[2])).toEqual([
    "operator main direction",
    "operator main direction",
  ]);
  expect(imageSlots("subportrait", 2).every((slot) => slot.style === "photo")).toBe(true);
});

test("initial photo diagnostics keep their selected slot after an earlier extra photo fails", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, logs } = await fixture({ ...subGenerator, portrait });
  portrait
    .mockImplementationOnce(subGenerator.portrait)
    .mockImplementationOnce(subGenerator.portrait)
    .mockRejectedValueOnce(new Error("first extra failed"));
  const response = await admin(
    request("/personas", {
      ...character,
      draft: await newToken(admin),
      intent: "generate",
      imageCount: "3",
    }),
  );
  expect(response.status).toBe(503);
  expect(
    logs
      .filter((entry) => entry.stage === "portrait.generate" && entry.event === "operation.started")
      .map((entry) => entry.poseIndex),
  ).toEqual([0, 0, 1, 2, 1, 2]);
});
