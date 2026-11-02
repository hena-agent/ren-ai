import { Schema } from "effect";
import { SocialAccount, SocialID } from "./social.ts";

export const SocialAuthAccount = Schema.Struct({
  id: SocialID,
  platform: SocialAccount.fields.platform,
  handle: SocialAccount.fields.handle,
  personaId: SocialID,
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
});
export type SocialAuthAccount = typeof SocialAuthAccount.Type;
const privateText = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
/** These inputs are transient secrets, never part of SocialAccount, tasks or history. */
export const SocialAuthCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("save"),
    username: privateText(320),
    password: privateText(4096),
  }),
  Schema.Struct({ kind: Schema.Literals(["status", "check", "login", "forget"]) }),
  Schema.Struct({
    kind: Schema.Literal("code"),
    code: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9 -]{4,64}$/)),
  }),
]);
export type SocialAuthCommand = typeof SocialAuthCommand.Type;
export const SocialAuthInput = Schema.Struct({ accountId: SocialID, command: SocialAuthCommand });
export const SocialAuthRequest = Schema.Struct({
  account: SocialAuthAccount,
  command: SocialAuthCommand,
});
export const SocialAuthStatus = Schema.Struct({
  state: Schema.Literals([
    "not_configured",
    "login_required",
    "logging_in",
    "checking",
    "authenticated",
    "code_required",
    "manual_required",
    "failed",
  ]),
  hasCredentials: Schema.Boolean,
  reason: Schema.optionalKey(
    Schema.Literals([
      "account_mismatch",
      "credentials_rejected",
      "unavailable",
      "check_unavailable",
      "interrupted",
    ]),
  ),
});
export type SocialAuthStatus = typeof SocialAuthStatus.Type;
