import { expect, test, vi } from "vitest";
import {
  character,
  fixture,
  generator,
  newToken,
  portraitImage,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import { basePreview, preview, subGenerator, savedPreview } from "../test/sub-portraits.ts";
import { queuedRequest, jobUrl, finishedJob, deferred } from "../test/queue.ts";

test("same saved-source submissions racing validation return one job and cannot consume twice", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, route, editing } = await savedPreview({ ...subGenerator, portrait });
  const fields = { ...character, draft: tokenOf(editing), intent: "subportrait", imageCount: "1" };
  const [first, duplicate] = await Promise.all([
    admin(queuedRequest(`${route}?style=photo`, fields)),
    admin(queuedRequest(`${route}?style=photo`, fields)),
  ]);
  expect(jobUrl(first)).toBe(jobUrl(duplicate));
  const complete = await finishedJob(admin, jobUrl(first));
  expect(preview(complete).secondaryPortraits).toHaveLength(1);
  expect(portrait).toHaveBeenCalledTimes(3);
});

test("one failed slot cannot be retried while its sibling is running; private retries validate origin, token, source and slot", async () => {
  const { promise: waiting, resolve: release } = deferred<typeof portraitImage>();
  const portrait = vi
    .fn<typeof generator.portrait>()
    .mockRejectedValueOnce(new Error("failed first main"))
    .mockReturnValueOnce(waiting)
    .mockImplementation(subGenerator.portrait);
  const { admin } = await fixture({ ...subGenerator, portrait });
  const accepted = await admin(
    queuedRequest("/personas", {
      ...character,
      draft: await newToken(admin),
      intent: "generate",
      imageCount: "1",
    }),
  );
  const path = jobUrl(accepted);
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(2));
  const current = await (await admin(request(path))).text();
  const fields = {
    ...character,
    draft: tokenOf(current),
    portraitInstructions: "retry private prompt",
  };
  expect((await admin(queuedRequest(`${path}/retry?image=0`, fields))).status).toBe(409);
  release(portraitImage);
  const partial = await finishedJob(admin, path);
  fields.draft = tokenOf(partial);
  const outside = queuedRequest(`${path}/retry?image=0`, fields);
  outside.headers.set("origin", "https://outside.example");
  expect((await admin(outside)).status).toBe(400);
  expect(
    (
      await admin(
        queuedRequest(`${path}/retry?image=0`, { ...fields, draft: await newToken(admin) }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await admin(queuedRequest(`${path}/retry?image=0`, { ...fields, name: "changed source" })))
      .status,
  ).toBe(400);
  for (const suffix of ["", "?image=-1", "?image=0.5", "?image=99", "?image=%200", "?image=0%20"])
    expect((await admin(queuedRequest(`${path}/retry${suffix}`, fields))).status).toBe(400);
  const wrongMethod = await admin(request(`${path}/retry`));
  expect(wrongMethod.status).toBe(404);
  expect(await wrongMethod.text()).not.toContain('class="card-link"');
  expect((await admin(queuedRequest(path, fields))).status).toBe(404);
  const upload = new FormData();
  for (const [key, value] of Object.entries(fields)) upload.set(key, value);
  upload.set("portraitInstructions", new File(["bad"], "prompt.txt"));
  expect(
    (await admin(new Request(request(`${path}/retry?image=0`), { method: "POST", body: upload })))
      .status,
  ).toBe(400);
  expect(portrait).toHaveBeenCalledTimes(2);
  expect((await admin(queuedRequest(`${path}/retry?image=0`, fields))).status).toBe(303);
  await finishedJob(admin, path);
  expect(portrait).toHaveBeenCalledTimes(3);
});

test("a saved source changed while waiting is rejected at worker start and the next persona still runs", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, store, page, logs } = await basePreview({ ...subGenerator, portrait });
  const record = preview(page);
  await store.create(record);
  const { promise: waiting, resolve: release } = deferred<typeof portraitImage>();
  portrait.mockReturnValueOnce(waiting);
  const first = await admin(
    queuedRequest("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(3));
  const route = `/personas/${record.id}`;
  const editing = await (await admin(request(route))).text();
  const stale = await admin(
    queuedRequest(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(editing),
      intent: "subportrait",
    }),
  );
  await store.update({ ...record, name: "Externally updated" });
  const third = await admin(
    queuedRequest("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  release(portraitImage);
  await finishedJob(admin, jobUrl(first));
  const rejected = await finishedJob(admin, jobUrl(stale));
  expect(rejected).toContain("다른 화면에서 캐릭터가 변경");
  await finishedJob(admin, jobUrl(third));
  expect(portrait).toHaveBeenCalledTimes(6);
  expect(
    logs.find(
      (entry) =>
        entry.jobId === jobUrl(stale).split("/").at(-1) && entry.event === "image.queue.completed",
    ),
  ).toMatchObject({ status: 409, level: "warn", outcome: "failed" });
});

test("non-Error preparation and image failures are diagnosed before becoming recoverable job results", async () => {
  const introduction = vi
    .fn<typeof generator.introduction>()
    .mockRejectedValueOnce("private unexpected text failure")
    .mockImplementation(generator.introduction);
  const { admin, logs } = await fixture({ ...subGenerator, introduction });
  const accepted = await admin(
    queuedRequest("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  const path = jobUrl(accepted);
  const failed = await finishedJob(admin, path);
  expect(failed).toContain('data-state="blocked"');
  expect(logs.find((entry) => entry.event === "operation.failed")?.error?.message).toBe(
    "Non-Error failure",
  );
  expect(JSON.stringify(logs)).not.toContain("private unexpected text failure");
  expect(
    (
      await admin(
        queuedRequest(`${path}/retry?image=0`, {
          ...character,
          draft: tokenOf(failed),
          portraitInstructions: "",
        }),
      )
    ).status,
  ).toBe(303);
  await finishedJob(admin, path);
  expect(introduction).toHaveBeenCalledTimes(2);
  const broken = await fixture({
    ...subGenerator,
    portrait: async () => {
      throw undefined;
    },
  });
  const images = await broken.admin(
    queuedRequest("/personas", {
      ...character,
      draft: await newToken(broken.admin),
      intent: "generate",
    }),
  );
  expect(await finishedJob(broken.admin, jobUrl(images))).toContain('data-state="failed"');
  expect(broken.logs.filter((entry) => entry.event === "operation.failed")).toHaveLength(2);
});

test("external secondary references fail before enqueue while owned bytes are validated at their read boundary", async () => {
  const { admin, page, store } = await basePreview();
  const record = preview(page);
  await store.create({
    ...record,
    secondaryPortraits: [{ style: "photo", imageUrl: "https://outside.example/picture.jpg" }],
  });
  const route = `/personas/${record.id}`;
  const editing = await (await admin(request(route))).text();
  expect(
    (
      await admin(
        queuedRequest(`${route}?style=photo&image=1`, {
          ...character,
          draft: tokenOf(editing),
          intent: "regenerate",
        }),
      )
    ).status,
  ).toBe(400);
});
