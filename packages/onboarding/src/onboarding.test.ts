import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  Handle,
  OnboardingAnswer,
  OnboardingRequest,
  WaitlistEmail,
  WaitlistRequest,
  normalizeHandle,
  normalizeWaitlistEmail,
} from "./index.ts";

describe("Handle", () => {
  it.each([
    ["010-1234-5678", "+821012345678"],
    ["010 1234 5678", "+821012345678"],
    ["01012345678", "+821012345678"],
    [" 01012345678 ", "+821012345678"],
    ["+82 10-1234-5678", "+821012345678"],
    ["02 123 4567", "+8221234567"],
    ["031 123 4567", "+82311234567"],
    ["070 1234 5678", "+827012345678"],
    ["  A.User@EXAMPLE.COM  ", "a.user@example.com"],
  ])("normalizes %s to %s", (input, normalized) => {
    expect(normalizeHandle(input)).toBe(normalized);
    expect(Schema.decodeUnknownSync(Handle)(normalized)).toBe(normalized);
  });

  it.each([
    null,
    12,
    "",
    "0101234567",
    "010123456789",
    "010-12x4-5678",
    "+1 2025550123",
    "010+12345678",
    "a@",
    "a b@example.com",
  ])("rejects invalid Handle %s", (input) => {
    expect(normalizeHandle(input)).toBeUndefined();
  });

  it("normalizes Waitlist email and rejects invalid input", () => {
    expect(normalizeWaitlistEmail("  H@Example.COM  ")).toBe("h@example.com");
    expect(normalizeWaitlistEmail(24)).toBeUndefined();
    expect(normalizeWaitlistEmail("hello@localhost")).toBeUndefined();
    expect(Schema.decodeUnknownSync(WaitlistEmail)("h@example.com")).toBe("h@example.com");
    expect(() => Schema.decodeUnknownSync(WaitlistEmail)("H@example.com")).toThrow("lowercase");
    expect(() => Schema.decodeUnknownSync(WaitlistEmail)("h@example.com.")).toThrow("Expected");
    expect(Schema.decodeUnknownSync(WaitlistEmail)("h@example.com.net")).toBe("h@example.com.net");
  });
});

describe("Onboarding contract", () => {
  const request = {
    handle: "+821012345678",
    locale: "ko",
    privacyNoticeVersion: "2026-09-26",
    turnstileToken: "token",
  };

  it("decodes a request and ignores fields unknown to the server", () => {
    expect(Schema.decodeUnknownSync(OnboardingRequest)({ ...request, persona: "later" })).toEqual(
      request,
    );
  });

  it.each([
    { ...request, handle: "01012345678" },
    { ...request, locale: "en" },
    { ...request, privacyNoticeVersion: "" },
    { ...request, turnstileToken: "" },
    { handle: request.handle },
  ])("rejects invalid Onboarding request %#", (invalid) => {
    expect(() => Schema.decodeUnknownSync(OnboardingRequest)(invalid)).toThrow(
      /Expected|Missing key/,
    );
  });

  it.each(["sent", "no_imessage", "unknown", "full", "try_later"])(
    "accepts answer %s",
    (answer) => {
      expect(Schema.decodeUnknownSync(OnboardingAnswer)(answer)).toBe(answer);
    },
  );

  it("rejects unexpected answers", () => {
    expect(() => Schema.decodeUnknownSync(OnboardingAnswer)("failed")).toThrow("Expected");
  });

  it.each(["+8210123456780", "x+821012345678", "+8231123456", "+8231abcdefg"])(
    "rejects invalid canonical phone %s",
    (invalid) => {
      expect(() => Schema.decodeUnknownSync(Handle)(invalid)).toThrow("Expected");
    },
  );

  it.each(["no_imessage", "unknown", "full"])("accepts Waitlist answer %s", (answer) => {
    expect(
      Schema.decodeUnknownSync(WaitlistRequest)({
        email: "user@example.com",
        locale: "ko",
        answer,
        persona: "later",
      }),
    ).toEqual({ email: "user@example.com", locale: "ko", answer });
  });

  it.each([
    { email: "invalid", locale: "ko", answer: "full" },
    { email: "user@example.com", locale: "en", answer: "full" },
    { email: "user@example.com", locale: "ko", answer: "sent" },
  ])("rejects invalid Waitlist request %#", (invalid) => {
    expect(() => Schema.decodeUnknownSync(WaitlistRequest)(invalid)).toThrow("Expected");
  });
});
