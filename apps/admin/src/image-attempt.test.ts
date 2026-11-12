import { expect, test, vi } from "vitest";
import { PersonaError } from "@ren-ai/personas";
import {
  beginAttempt,
  queueAttempt,
  finishAttempt,
  interruptAttempt,
  imageFailure,
} from "./image-attempt.ts";
import { GenerationError, loggedRequest, operation, protect } from "./logging.ts";
import type { ImageJob } from "./image-queue.ts";

const task = (): ImageJob["tasks"][number] => ({
  ordinal: 0,
  index: 0,
  style: "anime",
  state: "waiting",
});

test("attempts keep independent wait/start/end clocks and immutable failures across retry", () => {
  const row = task();
  vi.spyOn(Date, "now").mockReturnValue(5000);
  queueAttempt(row, 1000, "first", false);
  beginAttempt(row, 1000, "first", false);
  beginAttempt(row, 1000, "first", false);
  expect(row.attempts![0]).toMatchObject({ queuedAt: 1000, startedAt: 5000, requestId: "first" });
  const failure = imageFailure(
    new GenerationError("request rejected", { code: "http_error", status: 422 }),
    "rig.layers.generate",
  );
  vi.spyOn(Date, "now").mockReturnValue(12000);
  finishAttempt(row, "failed", failure);
  const previous = structuredClone(row.attempts![0]);
  finishAttempt(row, "completed");
  expect(row.attempts![0]).toEqual(previous);
  queueAttempt(row, 15000, "retry", true);
  vi.spyOn(Date, "now").mockReturnValue(17000);
  beginAttempt(row, 15000, "retry", true);
  finishAttempt(row, "completed");
  expect(row.attempts![0]).toEqual(previous);
  expect(row.attempts![1]).toMatchObject({ kind: "resume", state: "completed", finishedAt: 17000 });
  expect(row.durationMs).toBe(0);
  const blocked = task();
  queueAttempt(blocked, 16000, "blocked", false);
  finishAttempt(blocked, "blocked", failure);
  expect(blocked.attempts![0]).toMatchObject({ state: "blocked", finishedAt: 17000 });
  expect(blocked.durationMs).toBeUndefined();
});

test("interruption has an observation time, never an invented finish time or duration", () => {
  const row = task();
  finishAttempt(row, "failed");
  interruptAttempt(row);
  vi.spyOn(Date, "now").mockReturnValue(5000);
  beginAttempt(row, 1000, "current", false);
  vi.spyOn(Date, "now").mockReturnValue(20000);
  interruptAttempt(row);
  expect(row.attempts![0]).toMatchObject({
    state: "interrupted",
    startedAt: 5000,
    recoveredAt: 20000,
    failure: { code: "interrupted" },
  });
  expect(row.attempts![0]).not.toHaveProperty("finishedAt");
  expect(row.durationMs).toBeUndefined();
});

test("failure summaries retain the deepest operation, HTTP/code metadata and only safe diagnostics", async () => {
  let failure = imageFailure(new Error("private payload"), "fallback");
  expect(failure.summary).not.toContain("private payload");
  expect(failure.stage).toBe("fallback");
  await loggedRequest(
    new Request("http://localhost:3729/"),
    async () => {
      protect("private prompt");
      try {
        await operation("outer", {}, () =>
          operation("rig.layers.download", {}, async () => {
            throw new GenerationError("private prompt", {
              code: "provider_code",
              status: 503,
              causeName: "ProviderError",
            });
          }),
        );
      } catch (error) {
        if (!(error instanceof Error)) throw new Error("Expected provider error", { cause: error });
        failure = imageFailure(error, "outer");
      }
      expect(failure).toMatchObject({
        stage: "rig.layers.download",
        code: "provider_code",
        status: 503,
        causeName: "ProviderError",
      });
      expect(failure.summary).not.toContain("private prompt");
      return new Response();
    },
    () => {},
  );
  expect(
    imageFailure(new PersonaError("conflict", "기본 몸이 변경되었습니다."), "prepare"),
  ).toMatchObject({ code: "conflict", summary: "기본 몸이 변경되었습니다." });
  expect(imageFailure(new GenerationError("safe summary", {}), "generate").summary).toBe(
    "safe summary",
  );
  const cause = Object.assign(new Error("private original payload"), { code: "ECONNRESET" });
  const wrapped = new Error("private wrapper", { cause });
  expect(imageFailure(wrapped, "saving")).toMatchObject({
    code: "ECONNRESET",
    causeCode: "ECONNRESET",
    causeName: "Error",
  });
  expect(imageFailure(wrapped, "saving").summary).not.toContain("private");
  expect(
    imageFailure(Object.assign(new Error("private"), { code: 42 }), "saving"),
  ).not.toHaveProperty("code");
  expect(
    imageFailure(
      new GenerationError("provider failure", { code: "network_error", causeCode: "ECONNREFUSED" }),
      "generate",
    ),
  ).toMatchObject({ code: "network_error", causeCode: "ECONNREFUSED" });
});
