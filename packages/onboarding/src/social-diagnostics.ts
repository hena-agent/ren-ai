import { Schema } from "effect";
import { DeploymentRevision } from "@ren-ai/transport/deployment";

const safeCode = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,80}$/));
const httpStatus = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 100, maximum: 599 }),
);
export const SocialStage = Schema.Literals([
  "executor",
  "opening",
  "navigation",
  "identity",
  "history",
  "composer",
  "input",
  "attachment",
  "submit",
  "receipt",
  "generation",
  "storage",
  "review",
  "model",
  "recovery",
]);
export const SocialDiagnostic = Schema.Struct({
  requestId: safeCode,
  postId: Schema.optionalKey(safeCode),
  upstreamRequestId: Schema.optionalKey(safeCode),
  stage: SocialStage,
  submission: Schema.Literals(["not_attempted", "attempted", "verified"]),
  code: safeCode,
  at: Schema.Number,
  durationMs: Schema.Number,
  revision: Schema.optionalKey(DeploymentRevision),
  causeName: Schema.optionalKey(safeCode),
  causeCode: Schema.optionalKey(safeCode),
  upstreamStatus: Schema.optionalKey(httpStatus),
  stack: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
});
export type SocialDiagnostic = typeof SocialDiagnostic.Type;
export type SocialStage = typeof SocialStage.Type;
// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: allowlist failure metadata and strip payload-bearing messages and private paths
export function socialFailureCause(cause: unknown) {
  const error = cause instanceof Error ? cause : new Error("Non-Error failure");
  const root = error.cause instanceof Error ? error.cause : error;
  const code = "code" in root ? root.code : "code" in error ? error.code : undefined;
  const status =
    "upstreamStatus" in root
      ? root.upstreamStatus
      : "upstreamStatus" in error
        ? error.upstreamStatus
        : undefined;
  const provider = Schema.is(
    Schema.Struct({
      fields: Schema.Struct({
        code: Schema.optionalKey(safeCode),
        status: Schema.optionalKey(Schema.Number),
      }),
    }),
  )(root)
    ? root.fields
    : undefined;
  const selectedCode = Schema.is(safeCode)(code) ? code : provider?.code;
  const selectedStatus = typeof status === "number" ? status : provider?.status;
  const upstreamId =
    "requestId" in root ? root.requestId : "requestId" in error ? error.requestId : undefined;
  return {
    causeName: root.constructor.name,
    ...(typeof upstreamId === "string" &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(upstreamId) && {
        upstreamRequestId: upstreamId,
      }),
    ...(selectedCode && { causeCode: selectedCode }),
    ...(Schema.is(httpStatus)(selectedStatus) && { upstreamStatus: selectedStatus }),
    stack: (root.stack ?? "")
      .split("\n")
      .filter((line) => /^\s+at /.test(line))
      .flatMap((line) => {
        const frame = line.match(/([^/\s():]+\.(?:ts|js|mjs):\d+:\d+)/);
        return frame ? [`at ${frame[1]}`] : [];
      })
      .join("\n")
      .slice(0, 4000),
  };
}
export const SocialFailure = Schema.Struct({
  error: Schema.Literal("SOCIAL_BROWSER_FAILED"),
  diagnostic: SocialDiagnostic,
});
