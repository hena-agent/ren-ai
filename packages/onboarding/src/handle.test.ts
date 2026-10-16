import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { normalizeHandle } from "./index.ts";
import { Email } from "./shapes.ts";

describe("Handle", () => {
  it.each([
    ["010-1234-5678", "+821012345678"],
    ["010 1234 5678", "+821012345678"],
    ["01012345678", "+821012345678"],
    [" 01012345678 ", "+821012345678"],
    ["+82 10-1234-5678", "+821012345678"],
    ["+1 415 555 0100", "+14155550100"],
    ["+81 90-1234-5678", "+819012345678"],
    ["  A.User@EXAMPLE.COM  ", "a.user@example.com"],
  ])("normalizes %s to %s", (input, normalized) => {
    expect(normalizeHandle(input)).toBe(normalized);
  });

  it.each([
    null,
    12,
    "",
    "010123456789",
    "010-12x4-5678",
    "010+12345678",
    "02 123 4567",
    "070 1234 5678",
    "a@",
    "a b@example.com",
  ])("rejects invalid Handle %s", (input) => {
    expect(normalizeHandle(input)).toBeUndefined();
  });

  it("normalizes an email Handle and rejects invalid input", () => {
    expect(normalizeHandle("  H@Example.COM  ")).toBe("h@example.com");
    expect(normalizeHandle("hello@localhost")).toBeUndefined();
    expect(Schema.decodeUnknownSync(Email)("h@example.com")).toBe("h@example.com");
    expect(() => Schema.decodeUnknownSync(Email)("H@example.com")).toThrow("lowercase");
    expect(() => Schema.decodeUnknownSync(Email)("h@example.com.")).toThrow("Expected");
    expect(Schema.decodeUnknownSync(Email)("h@example.com.net")).toBe("h@example.com.net");
  });
});
