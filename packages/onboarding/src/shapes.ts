import { Schema } from "effect";

export const WaitlistEmail = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/)),
  Schema.check(Schema.isLowercased(), Schema.isTrimmed()),
);

const Phone = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\+82(?:10\d{8}|2\d{7,8}|[3-6][1-5]\d{7,8}|70\d{8})$/)),
);

export const Handle = Schema.Union([Phone, WaitlistEmail]);

export const OnboardingRequest = Schema.Struct({
  handle: Handle,
  locale: Schema.Literal("ko"),
  privacyNoticeVersion: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  turnstileToken: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
});

export const OnboardingAnswer = Schema.Literals([
  "sent",
  "no_imessage",
  "unknown",
  "full",
  "try_later",
]);

export const WaitlistRequest = Schema.Struct({
  email: WaitlistEmail,
  locale: Schema.Literal("ko"),
  answer: Schema.Literals(["no_imessage", "unknown", "full"]),
});
