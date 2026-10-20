import { expect, test, vi } from "vitest";
import { basePreview, preview } from "../test/sub-portraits.ts";
import {
  character,
  generator,
  newToken,
  portraitImage,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import { deferred, finishedJob, jobUrl, queuedRequest, runNextTask } from "../test/queue.ts";
import { durableFixture } from "../test/durable-admin.ts";
import { draftTokens } from "./draft.ts";
import { createImageBatch, restoreImageBatch } from "./image-batch.ts";

test("a committed sheet receipt repairs a lost draft checkpoint and confirmed retry does not regenerate its paid result", async () => {
  const sheet = vi.fn<typeof generator.sheet>().mockResolvedValue(portraitImage);
  const { open, state, store } = await durableFixture({ ...generator, sheet });
  let admin = open();
  const fresh = await (await admin(request("/new"))).text();
  const accepted = await admin(
    queuedRequest("/personas", { ...character, draft: tokenOf(fresh), intent: "sheets" }),
  );
  const path = jobUrl(accepted);
  const save = store.saveSheet.bind(store);
  vi.spyOn(store, "saveSheet").mockImplementationOnce(async (...args) => {
    await save(...args);
    state.unavailable = true;
  });
  let job = admin.nextJob()!;
  await expect(runNextTask(admin, () => {})).rejects.toThrow("storage unavailable");
  expect(sheet).toHaveBeenCalledTimes(1);
  const first = (await store.sheets(job.batch.personaId)).anime;
  expect(first).toBeTruthy();
  state.unavailable = false;
  admin = open();
  job = await runNextTask(admin, () => {});
  expect(sheet).toHaveBeenCalledTimes(2);
  const partial = await (await admin(request(path))).text();
  expect(partial).toContain(first!);
  const retry = await admin(
    queuedRequest(`${path}/retry?image=0`, { ...character, draft: tokenOf(partial) }),
  );
  expect(retry.status).toBe(303);
  job = await runNextTask(admin, () => {});
  expect(sheet).toHaveBeenCalledTimes(2);
  expect((await store.sheets(job.batch.personaId)).anime).toBe(first);
  expect(await (await admin(request(path))).text()).not.toContain('data-state="failed"');
});

test("sheet replacement shares FIFO with photos, reserves no gallery slots and locks competing same-persona work", async () => {
  const wait = deferred<typeof portraitImage>();
  const sheet = vi.fn<typeof generator.sheet>().mockReturnValueOnce(wait.promise);
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(generator.portrait);
  const { admin, store, page } = await basePreview({ ...generator, sheet, portrait });
  const original = preview(page);
  const before = await store.sheets(original.id);
  const fields = { ...character, draft: tokenOf(page) };
  const first = await admin(queuedRequest("/personas?style=anime", { ...fields, intent: "sheet" }));
  await vi.waitFor(() => expect(sheet).toHaveBeenCalledTimes(1));
  expect(
    (await admin(queuedRequest("/personas?style=anime", { ...fields, intent: "generate" }))).status,
  ).toBe(409);
  expect(
    (await admin(queuedRequest("/personas?style=photo", { ...fields, intent: "sheet" }))).status,
  ).toBe(409);
  expect((await admin(request("/personas", { ...fields, intent: "save" }))).status).toBe(409);
  const second = await admin(
    queuedRequest("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  expect(portrait).toHaveBeenCalledTimes(2);
  const pending = await (await admin(request(jobUrl(first)))).text();
  expect(pending).not.toContain("대기 1장");
  wait.resolve(portraitImage);
  const done = await finishedJob(admin, jobUrl(first));
  await finishedJob(admin, jobUrl(second));
  expect(portrait).toHaveBeenCalledTimes(3);
  expect((await store.sheets(original.id)).anime).not.toBe(before.anime);
  expect(preview(done)).toEqual(original);
});

test("interrupted sheet work is not paid twice after actor replacement and retry preserves the completed style", async () => {
  const sheet = vi.fn<typeof generator.sheet>().mockResolvedValue(portraitImage);
  const { open, state, store, logs } = await durableFixture({ ...generator, sheet });
  let admin = open();
  const fresh = await (await admin(request("/new"))).text();
  const first = await admin(
    queuedRequest("/personas", { ...character, draft: tokenOf(fresh), intent: "sheets" }, [
      "private anime",
      "private photo",
    ]),
  );
  const path = jobUrl(first);
  let job = await runNextTask(admin, (entry) => logs.push(entry));
  const completed = await store.sheets(job.batch.personaId);
  expect(completed.anime).toBeTruthy();
  expect(completed.photo).toBeUndefined();
  state.saved!.queue.jobs[0]!.tasks[1]!.state = "generating";
  admin = open();
  job = await runNextTask(admin, (entry) => logs.push(entry));
  expect(sheet).toHaveBeenCalledTimes(1);
  expect(admin.nextJob()).toBeUndefined();
  const partial = await (await admin(request(path))).text();
  expect(partial).toContain("인물 시트");
  const retry = await admin(
    queuedRequest(`${path}/retry?image=1`, {
      ...character,
      draft: tokenOf(partial),
      portraitInstructions: "private retry",
    }),
  );
  expect(retry.status).toBe(303);
  job = await runNextTask(admin, (entry) => logs.push(entry));
  expect(sheet).toHaveBeenCalledTimes(2);
  expect(sheet.mock.calls[1]?.slice(1)).toEqual(["photo", "private retry", undefined]);
  expect((await store.sheets(job.batch.personaId)).anime).toBe(completed.anime);
  expect(logs.filter((entry) => entry.code === "interrupted")).toHaveLength(1);
  expect(JSON.stringify(logs)).not.toContain("private retry");
});

test("stale queued and retried photo work cannot use an identity sheet that has since been replaced", async () => {
  const { store, page } = await basePreview();
  const draft = draftTokens("test-password").decode(tokenOf(page));
  const batch = createImageBatch(
    preview(page),
    { ...draft, imageCount: 1 },
    "generate",
    new URLSearchParams({ style: "photo" }),
    "generate:photo",
    generator,
    store,
  );
  const next = await store.saveImage(portraitImage);
  await store.saveSheet(draft.id, "photo", next, draft.sheets!.photo);
  await expect(batch.prepare()).rejects.toMatchObject({ kind: "conflict" });
  expect(() => batch.resume({ ...draft, sheets: { ...draft.sheets, photo: next } }, [0])).toThrow(
    /인물 시트가 변경/,
  );
  const obsolete = batch.snapshot();
  Reflect.deleteProperty(obsolete, "operationId");
  expect(() => restoreImageBatch(obsolete, generator, store)).toThrow(/생성 식별자/);
  const unsupported = batch.snapshot();
  Reflect.set(unsupported, "intent", "portrait");
  expect(() => restoreImageBatch(unsupported, generator, store)).toThrow(
    /지원하지 않는 이미지 작업/,
  );
});
