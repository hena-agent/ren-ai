import { expect, test } from "vitest";
import { Schema } from "effect";
import { SocialDiagnostic, socialFailureCause } from "./social-diagnostics.ts";
test("outer transport correlation survives a nested cause", () => {
  expect(
    socialFailureCause(
      Object.assign(new Error("outer", { cause: new Error("root") }), {
        requestId: "10000000-0000-4000-8000-000000000001",
        upstreamStatus: 502,
      }),
    ),
  ).toMatchObject({
    upstreamRequestId: "10000000-0000-4000-8000-000000000001",
    upstreamStatus: 502,
  });
});

test("failure metadata excludes messages, private paths and malformed provider codes", () => {
  const root = Object.assign(new Error("PRIVATE_PASSWORD.ts:1:2"), {
    code: "ECONNRESET",
    upstreamStatus: 503,
  });
  root.stack =
    "Error: PRIVATE_PASSWORD.ts:1:2\n    at execute (/private/persona/secret/browser.ts:12:3)\n    at native (node:internal:1:1)";
  const safe = socialFailureCause(new Error("private outer", { cause: root }));
  expect(safe).toMatchObject({
    causeCode: "ECONNRESET",
    upstreamStatus: 503,
    stack: "at browser.ts:12:3",
  });
  expect(JSON.stringify(safe)).not.toContain("PRIVATE_PASSWORD");
  expect(JSON.stringify(safe)).not.toContain("/private/");
  expect(socialFailureCause("private").causeName).toBe("Error");
  expect(
    socialFailureCause(
      Object.assign(new Error("private"), { code: "bad private code", upstreamStatus: 700 }),
    ),
  ).not.toHaveProperty("causeCode");
  expect(
    socialFailureCause(
      Object.assign(new Error("private"), { fields: { code: "provider_failed", status: 429 } }),
    ),
  ).toMatchObject({ causeCode: "provider_failed", upstreamStatus: 429 });
  expect(
    socialFailureCause(
      Object.assign(new Error("private"), { code: "OUTER", cause: new Error("root") }),
    ).causeCode,
  ).toBe("OUTER");
  expect(
    Schema.is(SocialDiagnostic)({
      ...safe,
      requestId: "request",
      stage: "submit",
      submission: "attempted",
      code: "SOCIAL_FAILED",
      at: 1,
      durationMs: 1,
    }),
  ).toBe(true);
  const empty = new Error("private");
  delete empty.stack;
  expect(socialFailureCause(empty).stack).toBe("");
  for (const status of [0, 99, 499.5, 600])
    expect(
      socialFailureCause(Object.assign(new Error("private"), { upstreamStatus: status })),
    ).not.toHaveProperty("upstreamStatus");
  expect(
    socialFailureCause(Object.assign(new Error("private"), { fields: {} })),
  ).not.toHaveProperty("causeCode");
  expect(
    socialFailureCause(
      Object.assign(new Error("private"), { requestId: "10000000-0000-4000-8000-000000000001" }),
    ).upstreamRequestId,
  ).toBe("10000000-0000-4000-8000-000000000001");
  expect(
    socialFailureCause(
      Object.assign(new Error("private"), {
        requestId: "PRIVATE_TOKEN",
        upstreamStatus: "not a status",
      }),
    ),
  ).not.toHaveProperty("upstreamRequestId");
});
