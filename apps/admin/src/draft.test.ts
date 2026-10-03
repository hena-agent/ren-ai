import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { draftTokens } from "./draft.ts";

test("draft decoding validates the envelope even when a signature is valid", () => {
  const tokens = draftTokens("test-password");
  for (const value of [
    null,
    { id: 12, base: "", preview: "" },
    { id: "draft", base: null, preview: "" },
    { id: "draft", base: "", preview: {} },
    { id: "draft", preview: "" },
  ]) {
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    const signature = createHmac("sha256", "test-password").update(body).digest("base64url");
    expect(() => tokens.decode(`${body}.${signature}`)).toThrow(/Expected|Missing key/);
  }
});
