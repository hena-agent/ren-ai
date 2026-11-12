import { expect, test } from "vitest";
import { privateTokens } from "./private-token.ts";

test("signed private values reject malformed, truncated and same-length forged signatures", () => {
  const tokens = privateTokens("server-secret");
  const value = tokens.encode('{"model":"future-image"}');
  expect(tokens.decode(value)).toBe('{"model":"future-image"}');
  for (const invalid of [
    null,
    "",
    ".signature",
    "content.",
    "a.b.c",
    "content.x",
    privateTokens("wrong-secret").encode('{"model":"future-image"}'),
  ])
    expect(() => tokens.decode(invalid)).toThrow("폼 데이터");
});
