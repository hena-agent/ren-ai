import { expect, test } from "vitest";
import { browserTrace } from "./browser-trace.ts";
import type { SocialDiagnostic } from "@ren-ai/onboarding/social-diagnostics";

test("traces persist phase before I/O and preserve precise pre/post-submit failures without raw payloads", async () => {
  const checkpoints: SocialDiagnostic[] = [];
  const trace = browserTrace({
    requestId: "request",
    progress: async (d) => {
      checkpoints.push(d);
    },
  });
  await trace.at("composer");
  const failure = Object.assign(new Error("PRIVATE_PASSWORD"), { code: "COMMAND_FAILED" });
  await expect(
    trace.run(async () => {
      throw failure;
    }),
  ).rejects.toMatchObject({
    diagnostic: { stage: "composer", submission: "not_attempted", causeCode: "COMMAND_FAILED" },
  });
  expect(JSON.stringify(checkpoints)).not.toContain("PRIVATE_PASSWORD");
  await trace.at("submit", "attempted");
  await expect(
    trace.run(async () => {
      throw "private text";
    }),
  ).rejects.toMatchObject({ diagnostic: { stage: "submit", submission: "attempted" } });
  expect(await trace.run(async () => "ok")).toBe("ok");
  await trace.at("receipt", "verified", "ABC123");
  expect(checkpoints.at(-1)).toMatchObject({
    submission: "verified",
    postId: "ABC123",
    code: "SOCIAL_CONFIRMED",
  });
  await browserTrace().at("opening");
});
