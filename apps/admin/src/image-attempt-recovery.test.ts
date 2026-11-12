import { expect, test, vi } from "vitest";
import {
  character,
  generator,
  newToken,
  portraitImage,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import { durableFixture } from "../test/durable-admin.ts";
import { GenerationError, loggedJob, operation } from "./logging.ts";

test("durable attempts retain failure evidence after actor replacement and append a successful retry", async () => {
  let now = Date.UTC(2026, 10, 11, 6, 0);
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const portrait = vi
    .fn<typeof generator.portrait>()
    .mockImplementationOnce(async () => {
      now += 4250;
      return operation("generation.api", {}, async () => {
        throw new GenerationError("request failed", { code: "http_error", status: 422 });
      });
    })
    .mockResolvedValue(portraitImage);
  const { open, state } = await durableFixture({ ...generator, portrait });
  let admin = open();
  const registration = await admin(
    request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  const path = registration.headers.get("location")!;
  now += 2000;
  let job = admin.nextJob()!;
  await loggedJob(job.requestId, { jobId: job.id }, admin.runNext, () => {});
  const previous = structuredClone(state.saved!.queue.jobs[0]!.tasks[0]!.attempts![0]!);
  expect(previous.finishedAt! - previous.startedAt!).toBe(4250);
  expect(previous.startedAt! - previous.queuedAt).toBe(2000);
  expect(previous.failure).toMatchObject({
    stage: "generation.api",
    code: "http_error",
    status: 422,
  });
  admin = open();
  const failed = await (await admin(request(path))).text();
  expect(failed).toContain("공급자 HTTP 422");
  expect(failed).toContain("2026. 11. 11. 15:00:02 KST");
  now += 3000;
  const retried = await admin(
    request(`${path}/retry?image=0`, { ...character, draft: tokenOf(failed) }),
  );
  expect(retried.status).toBe(303);
  now += 1000;
  job = admin.nextJob()!;
  await loggedJob(job.requestId, { jobId: job.id }, admin.runNext, () => {});
  const attempts = state.saved!.queue.jobs[0]!.tasks[0]!.attempts!;
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(previous);
  expect(attempts[1]).toMatchObject({ state: "completed", kind: "generation" });
  expect(portrait).toHaveBeenCalledTimes(2);
});

test("actor recovery marks uncertain work without fabricating its failure time or resubmitting paid generation", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockResolvedValue(portraitImage);
  const { open, state } = await durableFixture({ ...generator, portrait });
  let admin = open();
  await admin(
    request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  const row = state.saved!.queue.jobs[0]!.tasks[0]!;
  row.state = "saving";
  row.startedAt = 1000;
  Object.assign(row.attempts![0]!, {
    startedAt: 1000,
    state: "running",
    stage: "image.queue.saving",
  });
  admin = open();
  const job = admin.nextJob()!;
  expect(job.tasks[0]!.attempts![0]).toMatchObject({
    state: "interrupted",
    failure: { stage: "image.queue.saving", code: "interrupted" },
  });
  expect(job.tasks[0]!.attempts![0]).not.toHaveProperty("finishedAt");
  await loggedJob(job.requestId, { jobId: job.id }, admin.runNext, () => {});
  expect(portrait).not.toHaveBeenCalled();
  const page = await (await admin(request(`/image-jobs/${job.id}`))).text();
  expect(page).toContain("실제 중단 시각은 알 수 없음");
  expect(page).toContain("결과 불확실");
});
