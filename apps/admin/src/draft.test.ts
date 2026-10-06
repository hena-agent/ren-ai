import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { draftTokens } from "./draft.ts";
import { subPlan } from "../test/sub-portraits.ts";

test("draft decoding validates the envelope even when a signature is valid", () => {
  const tokens = draftTokens("test-password");
  for (const value of [
    null,
    { id: 12, base: "", preview: "" },
    { id: "draft", base: null, preview: "" },
    { id: "draft", base: "", preview: {} },
    { id: "draft", preview: "" },
    { id: "draft", base: "", preview: "", portraitInstructions: 42 },
  ]) {
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    const signature = createHmac("sha256", "test-password").update(body).digest("base64url");
    expect(() => tokens.decode(`${body}.${signature}`)).toThrow(/Expected|Missing key/);
  }
});

test("legacy suggestion and completion records are discarded from private drafts", () => {
  const tokens = draftTokens("test-password");
  for (const completed of [[-1], [5], [0.5], [0, 0]]) {
    const body = Buffer.from(
      JSON.stringify({
        id: "draft",
        base: "",
        preview: "",
        recommendation: { ...subPlan(5), id: "plan", completed },
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", "test-password").update(body).digest("base64url");
    expect(tokens.decode(`${body}.${signature}`)).not.toHaveProperty("recommendation");
  }
});
