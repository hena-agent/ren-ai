import { Schema } from "effect";
import { InvitationCode } from "./invitation-code.ts";

const bounded = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));
export const SocialID = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/));
export const XHandle = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_]{1,15}$/));
const integer = (minimum: number, maximum: number) =>
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum, maximum }));

export const SocialAccount = Schema.Struct({
  id: SocialID,
  handle: XHandle,
  personaId: SocialID,
  enabled: Schema.Boolean,
  instructions: bounded(6000),
  invitation: InvitationCode,
  timeZone: Schema.String.check(Schema.isMaxLength(100)),
  startHour: integer(0, 23),
  endHour: integer(1, 24),
  intervalMinutes: integer(15, 1440),
  runMinutes: integer(1, 30),
  dailyTurns: integer(1, 200),
  dailyWrites: integer(1, 100),
});
export type SocialAccount = typeof SocialAccount.Type;

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000));
const postText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(280));
const status = Schema.String.check(
  Schema.isPattern(/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+$/),
);
export const SocialAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("search"), query: bounded(200) }),
  Schema.Struct({ kind: Schema.Literal("profile"), handle: XHandle }),
  Schema.Struct({ kind: Schema.Literal("read_post"), url: status }),
  Schema.Struct({ kind: Schema.Literals(["notifications", "inbox", "messages"]) }),
  Schema.Struct({ kind: Schema.Literal("post"), text: postText }),
  Schema.Struct({ kind: Schema.Literal("reply"), url: status, text: postText }),
  Schema.Struct({ kind: Schema.Literal("dm"), text }),
  Schema.Struct({
    kind: Schema.Literal("contact"),
    handle: Schema.NullOr(XHandle),
    publicContext: Schema.optionalKey(bounded(1200)),
  }),
  Schema.Struct({ kind: Schema.Literal("finish") }),
]);
export type SocialAction = typeof SocialAction.Type;
export const SocialDecision = Schema.Struct({ action: SocialAction, reason: bounded(600) });
export type SocialDecision = typeof SocialDecision.Type;
export const SocialResult = Schema.Struct({
  text: bounded(24000),
  url: Schema.optionalKey(status),
});
export type SocialResult = typeof SocialResult.Type;
export const SocialRun = Schema.Struct({
  id: SocialID,
  accountId: SocialID,
  generation: integer(1, Number.MAX_SAFE_INTEGER),
  requestId: Schema.String,
  deadline: Schema.Number,
  contact: Schema.NullOr(XHandle),
  step: integer(0, 200),
});
export type SocialRun = typeof SocialRun.Type;
export const SocialControl = Schema.Struct({
  run: SocialRun,
  account: SocialAccount,
  history: Schema.optionalKey(bounded(12000)),
});
export const SocialTask = Schema.Struct({ ...SocialControl.fields, snapshot: bounded(100000) });
export type SocialTask = typeof SocialTask.Type;
export const SocialBrowserRequest = Schema.Struct({
  ...SocialControl.fields,
  action: SocialAction,
  id: SocialID,
});
export const SocialStep = Schema.Struct({
  runId: SocialID,
  step: integer(0, 200),
  decision: SocialDecision,
});
export const SocialEvent = Schema.Struct({
  id: Schema.Number,
  runId: Schema.String,
  accountId: Schema.String,
  personaId: Schema.String,
  at: Schema.Number,
  kind: Schema.String,
  state: Schema.Literals(["pending", "completed", "uncertain", "failed"]),
  reason: bounded(600),
  text: bounded(24000),
  url: Schema.NullOr(Schema.String),
});
export const SocialAccountStatus = Schema.Struct({
  account: SocialAccount,
  generation: Schema.Number,
  nextAt: Schema.NullOr(Schema.Number),
  state: Schema.String,
  turns: Schema.Number,
  writes: Schema.Number,
});
export const SocialSnapshot = Schema.Struct({
  accounts: Schema.Array(SocialAccountStatus),
  events: Schema.Array(SocialEvent),
  before: Schema.NullOr(Schema.Number),
});
export type SocialSnapshot = typeof SocialSnapshot.Type;

export const socialWrite = (action: SocialAction) =>
  action.kind === "post" || action.kind === "reply" || action.kind === "dm";

/** Wall-clock activity windows follow the account timezone, including DST. */
export function socialTime(account: SocialAccount, now: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: account.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return {
    day: `${value("year")}-${value("month")}-${value("day")}`,
    active: Number(value("hour")) >= account.startHour && Number(value("hour")) < account.endHour,
  };
}

export function nextSocialTime(account: SocialAccount, now: number, tomorrow = false) {
  let next = now;
  const day = socialTime(account, now).day;
  for (let minute = 0; minute <= 3000; minute++) {
    const local = socialTime(account, next);
    if (local.active && (!tomorrow || local.day !== day)) return next;
    next += 60_000;
  }
  throw new Error("Invalid social activity window");
}
