import { expect, test } from "vitest";
import { Schema } from "effect";
import { nextSocialTime, socialTime, SocialAccount, SocialAction, socialWrite } from "./social.ts";
import { socialAccount } from "./social.test-helper.ts";

test("social windows use account-local dates and move sleeping work to the next active hour", () => {
  const now = Date.parse("2026-10-30T14:00:00Z");
  expect(socialTime(socialAccount, now)).toEqual({ day: "2026-10-30", active: false });
  expect(nextSocialTime(socialAccount, now)).toBe(Date.parse("2026-10-31T00:00:00Z"));
  expect(nextSocialTime(socialAccount, Date.parse("2026-10-30T01:00:00Z"))).toBe(
    Date.parse("2026-10-30T01:00:00Z"),
  );
  expect(() => nextSocialTime({ ...socialAccount, startHour: 22, endHour: 9 }, now)).toThrow(
    "Invalid social activity window",
  );
});
test("social input rejects arbitrary navigation, code and invalid account boundaries", () => {
  for (const input of [
    { kind: "eval", script: "steal()" },
    { kind: "read_post", url: "https://evil.test/a" },
    { kind: "reply", url: "https://x.com/a/status/1", text: "a".repeat(281) },
  ])
    expect(() => Schema.decodeUnknownSync(SocialAction)(input)).toThrow(Error);
  expect(() =>
    Schema.decodeUnknownSync(SocialAccount)({ ...socialAccount, dailyWrites: 0 }),
  ).toThrow(Error);
  expect(socialWrite({ kind: "post", text: "a" })).toBe(true);
  expect(socialWrite({ kind: "reply", url: "https://x.com/a/status/1", text: "b" })).toBe(true);
  expect(socialWrite({ kind: "dm", text: "c" })).toBe(true);
  expect(socialWrite({ kind: "messages" })).toBe(false);
});
