import { Schema } from "effect";
import { isPhoneHandle } from "./countries.ts";

export const WaitlistEmail = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/)),
  Schema.check(Schema.isLowercased(), Schema.isTrimmed()),
);

const Phone = Schema.String.pipe(Schema.refine((value): value is string => isPhoneHandle(value)));

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
