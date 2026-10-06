import { expect, test, vi } from "vitest";
import { character, generator, portraitImage, request, tokenOf } from "../test/fixtures.ts";
import { savedPreview, subGenerator, preview } from "../test/sub-portraits.ts";
import { deferred, finishedJob, jobUrl, queuedRequest } from "../test/queue.ts";

async function editor() {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const setup = await savedPreview({ ...subGenerator, portrait });
  const fields = { ...character, draft: tokenOf(setup.editing), intent: "subportrait" };
  const enqueue = (imageCount = "1", style = "photo", portraitInstructions = "") =>
    setup.admin(
      queuedRequest(`${setup.route}?style=${style}`, {
        ...fields,
        imageCount,
        portraitInstructions,
      }),
    );
  return { ...setup, portrait, fields, enqueue };
}

async function failedWithPending(imageCount: string) {
  const setup = await editor();
  setup.portrait.mockRejectedValueOnce(new Error("photo unavailable"));
  const failed = jobUrl(await setup.enqueue());
  const failurePage = await finishedJob(setup.admin, failed);
  const wait = deferred<typeof portraitImage>();
  setup.portrait.mockReturnValueOnce(wait.promise);
  const next = await setup.enqueue(imageCount, "photo", "a distinct batch");
  await vi.waitFor(() => expect(setup.portrait).toHaveBeenCalledTimes(4));
  return { ...setup, failed, failurePage, wait, next };
}

test("completed rows in a running batch are counted as photos rather than reserving their slot twice", async () => {
  const { admin, portrait, enqueue, logs } = await editor();
  const wait = deferred<typeof portraitImage>();
  portrait.mockImplementationOnce(subGenerator.portrait).mockReturnValueOnce(wait.promise);
  const first = await enqueue("2");
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(4));
  const partial = await (await admin(request(jobUrl(first)))).text();
  expect(preview(partial).secondaryPortraits).toHaveLength(1);
  const second = await enqueue("3");
  expect(second.status).toBe(303);
  wait.resolve(portraitImage);
  await finishedJob(admin, jobUrl(first));
  expect(preview(await finishedJob(admin, jobUrl(second))).secondaryPortraits).toHaveLength(5);
  expect(
    logs
      .filter((entry) => entry.stage === "portrait.generate" && entry.event === "operation.started")
      .slice(2)
      .map((entry) => entry.poseIndex),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("saving rows still reserve capacity until their photo enters the preview", async () => {
  const { admin, store, enqueue } = await editor();
  await finishedJob(admin, jobUrl(await enqueue("4")));
  const wait = deferred<void>();
  const save = store.saveImage.bind(store);
  vi.spyOn(store, "saveImage").mockImplementationOnce(async (image) => {
    await wait.promise;
    return save(image);
  });
  const first = await enqueue();
  await vi.waitFor(async () =>
    expect(await (await admin(request(jobUrl(first)))).text()).toContain('data-state="saving"'),
  );
  expect((await enqueue("1", "photo", "another confirmed request")).status).toBe(400);
  wait.resolve(undefined);
  expect(preview(await finishedJob(admin, jobUrl(first))).secondaryPortraits).toHaveLength(5);
});

test("regeneration reserves no extra photo and the next addition uses its completed same-style main", async () => {
  const { admin, route, editing, original, portrait, enqueue } = await editor();
  await finishedJob(admin, jobUrl(await enqueue("4")));
  const wait = deferred<typeof portraitImage>();
  portrait.mockReturnValueOnce(wait.promise);
  const replacement = await admin(
    queuedRequest(`${route}?style=photo&image=${encodeURIComponent(original.portraits!.photo!)}`, {
      ...character,
      draft: tokenOf(editing),
      intent: "regenerate",
    }),
  );
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(7));
  const addition = await enqueue();
  expect(addition.status).toBe(303);
  wait.resolve(portraitImage);
  await finishedJob(admin, jobUrl(replacement));
  const completed = preview(await finishedJob(admin, jobUrl(addition)));
  expect(completed.secondaryPortraits).toHaveLength(5);
  expect(completed.portraits!.photo).not.toBe(original.portraits!.photo);
  expect(portrait.mock.calls.at(-1)![3]!.mimeType).toBe("image/png");
});

test("a failed row can wait behind another same-persona batch and keeps its newly completed sibling", async () => {
  const { admin, portrait, fields, failed, failurePage, wait, next } = await failedWithPending("1");
  const retried = await admin(
    queuedRequest(`${failed}/retry?image=0`, { ...fields, draft: tokenOf(failurePage) }),
  );
  expect(retried.status).toBe(303);
  wait.resolve(portraitImage);
  await finishedJob(admin, jobUrl(next));
  expect(preview(await finishedJob(admin, failed)).secondaryPortraits).toHaveLength(2);
  expect(portrait).toHaveBeenCalledTimes(5);
});

test("retrying a failed row cannot consume capacity already reserved by another batch", async () => {
  const { admin, portrait, fields, failed, failurePage, wait, next } = await failedWithPending("5");
  const rejected = await admin(
    queuedRequest(`${failed}/retry?image=0`, { ...fields, draft: tokenOf(failurePage) }),
  );
  expect(rejected.status).toBe(400);
  expect(portrait).toHaveBeenCalledTimes(4);
  wait.resolve(portraitImage);
  const page = await finishedJob(admin, jobUrl(next));
  expect(preview(page).secondaryPortraits).toHaveLength(5);
  expect(page).toContain(`data-image-job="${failed.split("/").at(-1)}"`);
  expect(page).toContain('data-state="failed"');
});

test("a legacy completed response retains source locks when another same-persona batch is still waiting", async () => {
  const { admin, route, fields, portrait, enqueue } = await editor();
  const firstImage = deferred<typeof portraitImage>();
  const secondImage = deferred<typeof portraitImage>();
  portrait.mockReturnValueOnce(firstImage.promise).mockReturnValueOnce(secondImage.promise);
  const first = admin(
    request(`${route}?style=photo`, { ...fields, portraitInstructions: "legacy first batch" }),
  );
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(3));
  const second = await enqueue();
  firstImage.resolve(portraitImage);
  const response = await first;
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('data-queue-locked="true"');
  secondImage.resolve(portraitImage);
  await finishedJob(admin, jobUrl(second));
});
