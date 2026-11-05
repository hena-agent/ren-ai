import { afterEach, expect, test, vi } from "vitest";
import { Schema } from "effect";
import { socialTestContext } from "../test/social.test-helper.ts";
import { createSocial } from "./social/http.ts";
import { socialGate } from "../test/social.test-helper.ts";
import type { SocialDiagnostic } from "@ren-ai/onboarding/social-diagnostics";

const context = socialTestContext();
afterEach(() => vi.restoreAllMocks());
const diagnostic: SocialDiagnostic = {
  requestId: "mac-request",
  stage: "composer",
  submission: "not_attempted",
  code: "SOCIAL_BROWSER_FAILED",
  causeCode: "SOCIAL_BROWSER_COMMAND",
  at: 1,
  durationMs: 200,
};
test.each(["not_attempted", "attempted"] as const)(
  "browser failure persists across actor replacement and preserves %s send certainty",
  async (submission) => {
    const f = context.fixture();
    await f.enable();
    f.options.browser = async () => {
      throw Object.assign(new Error("PRIVATE_PASSWORD private prompt"), {
        diagnostic: { ...diagnostic, submission },
      });
    };
    expect((await f.action(0, { kind: "post", text: "public draft" })).status).toBe(503);
    const replacement = createSocial(f.storage, f.options);
    const response = await replacement.fetch(
      new Request("https://api.test/management/social", {
        headers: { Authorization: "Bearer secret" },
      }),
    );
    const state = await response.text();
    expect(state).toContain('"stage":"composer"');
    expect(state).toContain('"requestId":"mac-request"');
    expect(state).toContain(
      submission === "not_attempted" ? '"state":"failed"' : '"state":"uncertain"',
    );
    expect((await f.snapshot()).accounts[0]!.writes).toBe(submission === "not_attempted" ? 0 : 1);
    expect(state + context.logs.join("")).not.toContain("PRIVATE_PASSWORD");
    expect(state + context.logs.join("")).not.toContain("private prompt");
    expect((await f.action(0, { kind: "post", text: "public draft" })).status).toBe(409);
  },
);
test("progress is durable, fenced to the admitted action, and contains no arbitrary diagnostic payloads", async () => {
  const f = context.fixture();
  await f.enable();
  expect((await f.request("/progress", { runId: f.started[0], step: 0, diagnostic })).status).toBe(
    409,
  );
  f.options.browser = async (run) => {
    expect(
      (
        await f.request("/progress", {
          runId: run.id,
          step: 0,
          diagnostic: { ...diagnostic, code: "SOCIAL_IN_PROGRESS" },
        })
      ).status,
    ).toBe(204);
    expect((await f.snapshot()).events[0]!.diagnostic?.stage).toBe("composer");
    expect((await f.request("/progress", { runId: run.id, step: 1, diagnostic })).status).toBe(409);
    throw new Error("private provider response");
  };
  await f.action(0, { kind: "post", text: "draft" });
  expect((await f.request("/progress", { runId: f.started[0], step: 0, diagnostic })).status).toBe(
    409,
  );
  expect(context.logs.join("")).not.toContain("private provider response");
});

test.each(["threads", "x"] as const)(
  "a lost %s reply retains the verified permalink and its last durable checkpoint",
  async (platform) => {
    const f = context.fixture();
    await f.enable({ platform });
    f.options.browser = async (run) => {
      expect(
        (
          await f.request("/progress", {
            runId: run.id,
            step: 0,
            diagnostic: {
              ...diagnostic,
              stage: "receipt",
              submission: "verified",
              code: "SOCIAL_CONFIRMED",
              postId: "123",
              upstreamStatus: 503,
            },
          })
        ).status,
      ).toBe(204);
      throw Object.assign(new Error("private transport detail"), { upstreamStatus: 503 });
    };
    expect((await f.action(0, { kind: "post", text: "draft" })).status).toBe(200);
    const event = (await f.snapshot()).events[0]!;
    expect(event).toMatchObject({
      state: "completed",
      url:
        platform === "threads"
          ? "https://www.threads.com/@persona_x/post/123"
          : "https://x.com/persona_x/status/123",
      diagnostic: { stage: "receipt", submission: "verified", postId: "123" },
    });
    expect(context.logs.join("")).not.toContain("private transport detail");
  },
);
test("a verified reply receipt is recovered as a completed action too", async () => {
  const f = context.fixture();
  await f.enable();
  f.options.browser = async (run) => {
    await f.request("/progress", {
      runId: run.id,
      step: 0,
      diagnostic: { ...diagnostic, stage: "receipt", submission: "verified", postId: "456" },
    });
    throw new Error("response lost");
  };
  const response = await f.action(0, {
    kind: "reply",
    url: "https://x.com/reader/status/456",
    text: "Reply",
  });
  expect(response.status).toBe(200);
  expect((await f.snapshot()).events[0]).toMatchObject({
    state: "completed",
    url: "https://x.com/persona_x/status/456",
  });
});

test("a malformed platform receipt ID cannot replace the stored link or checkpoint", async () => {
  const f = context.fixture();
  await f.enable();
  f.options.browser = async (run) => {
    expect(
      (
        await f.request("/progress", {
          runId: run.id,
          step: 0,
          diagnostic: {
            ...diagnostic,
            stage: "receipt",
            submission: "verified",
            postId: "not-a-numeric-x-id",
          },
        })
      ).status,
    ).toBe(400);
    throw new Error("receipt missing");
  };
  await f.action(0, { kind: "post", text: "draft" });
  expect((await f.snapshot()).events[0]!.url).toBeNull();
});

test("failure logging remains observable when persisting the diagnostic itself fails", async () => {
  const f = context.fixture();
  await f.enable();
  f.db.exec(
    "CREATE TRIGGER reject_diagnostic BEFORE INSERT ON social_diagnostic BEGIN SELECT RAISE(FAIL,'diagnostic storage unavailable'); END",
  );
  f.options.browser = async () => {
    throw Object.assign(new Error("PRIVATE_CONTENT"), { code: "ORIGINAL_FAILURE" });
  };
  expect((await f.action(0, { kind: "post", text: "draft" })).status).toBe(503);
  expect(context.logs.join("")).toContain('"causeCode":"ORIGINAL_FAILURE"');
  expect(context.logs.join("")).not.toContain("PRIVATE_CONTENT");
});
test("non-Error browser failures retain a safe action-level diagnostic", async () => {
  const f = context.fixture();
  await f.enable();
  f.options.browser = async () => {
    throw "PRIVATE_BROWSER_PAYLOAD";
  };
  expect((await f.action(0, { kind: "post", text: "draft" })).status).toBe(503);
  expect((await f.snapshot()).events[0]!.diagnostic).toMatchObject({
    code: "SOCIAL_ACTION_FAILED",
    stage: "executor",
  });
  expect(context.logs.join("")).not.toContain("PRIVATE_BROWSER_PAYLOAD");
});
test.each(["header", "stream"] as const)(
  "the API rejects oversized social %s requests before unbounded parsing",
  async (source) => {
    const f = context.fixture();
    const request =
      source === "header"
        ? new Request("https://api.test/management/social/actions", {
            method: "POST",
            headers: { Authorization: "Bearer secret", "Content-Length": "1000000" },
            body: "{}",
          })
        : new Request("https://api.test/management/social/actions", {
            method: "POST",
            headers: { Authorization: "Bearer secret" },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(32001));
                controller.close();
              },
            }),
            duplex: "half",
          });
    const response = await f.app.fetch(request);
    expect(response.status).toBe(413);
    expect(
      Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }))(await response.json())
        .error,
    ).toBe("SOCIAL_INPUT_SIZE");
  },
);
test("the API consumes rejection from oversized request cancellation", async () => {
  const f = context.fixture();
  vi.spyOn(ReadableStream.prototype, "cancel").mockRejectedValue(new Error("PRIVATE_CANCEL_TEXT"));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(32001));
      controller.close();
    },
  });
  const response = await f.app.fetch(
    new Request("https://api.test/management/social/actions", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Length": "1000000" },
      body,
      duplex: "half",
    }),
  );
  expect(response.status).toBe(413);
  expect(JSON.stringify(context.logs)).not.toContain("PRIVATE_CANCEL_TEXT");
});
test("API body parsers reject bodyless posts and absorb rejected reader cancellation", async () => {
  const f = context.fixture();
  const empty = await f.app.fetch(
    new Request("https://api.test/management/social/actions", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
    }),
  );
  expect(empty.status).toBe(400);
  vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel").mockRejectedValue(
    new Error("PRIVATE_READER_CANCEL"),
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(32001));
    },
  });
  const tooLarge = await f.app.fetch(
    new Request("https://api.test/management/social/actions", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
      body,
      duplex: "half",
    }),
  );
  expect(tooLarge.status).toBe(413);
  expect(context.logs.join("")).not.toContain("PRIVATE_READER_CANCEL");
});
test("malformed UTF-8 social request bodies return an input error", async () => {
  const f = context.fixture();
  const response = await f.app.fetch(
    new Request("https://api.test/management/social/actions", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
      body: new Uint8Array([0xff]),
    }),
  );
  expect(response.status).toBe(400);
  expect(
    Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }))(await response.json()).error,
  ).toBe("SOCIAL_INPUT_INVALID");
});

test("model failures and interrupted in-flight actions receive durable failure records", async () => {
  const f = context.fixture();
  await f.enable();
  const admitted = socialGate<void>(),
    release = socialGate<void>();
  f.options.browser = async () => {
    admitted.resolve();
    await release.promise;
    throw new Error("private browser failure");
  };
  const operation = f.action(0, { kind: "post", text: "draft" });
  await admitted.promise;
  expect((await f.request("/complete", { runId: f.started[0], state: "failed" })).status).toBe(204);
  expect((await f.snapshot()).events[0]!.diagnostic?.submission).toBe("attempted");
  release.resolve();
  await operation;
  const model = context.fixture();
  await model.enable();
  await model.request("/complete", {
    runId: model.started[0],
    state: "failed",
    diagnostic: {
      ...diagnostic,
      stage: "model",
      submission: "not_attempted",
      code: "MODEL_FAILED",
    },
  });
  expect((await model.snapshot()).events[0]).toMatchObject({
    kind: "execution",
    state: "failed",
    diagnostic: { code: "MODEL_FAILED", stage: "model" },
  });
});
