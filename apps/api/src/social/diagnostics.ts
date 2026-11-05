import { Schema } from "effect";
import { SocialDiagnostic, socialFailureCause } from "@ren-ai/onboarding/social-diagnostics";
import { contactLog, type ContactDiagnostic } from "../discovery/diagnostics.ts";
import type { SocialStore } from "./store.ts";
import type { SocialRun } from "@ren-ai/onboarding/social";
import { buildRevision } from "@ren-ai/transport/health";
import type { SocialService } from "./service.ts";

const WithDiagnostic = Schema.Struct({ diagnostic: SocialDiagnostic });
// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow executor failures into allowlisted diagnostics without their payloads
export function actionDiagnostic(cause: unknown, run: SocialRun, now: number): SocialDiagnostic {
  if (Schema.is(WithDiagnostic)(cause)) return cause.diagnostic;
  const safe = socialFailureCause(cause);
  return {
    requestId: run.requestId,
    stage: "executor",
    submission: "attempted",
    code: safe.causeCode ?? "SOCIAL_ACTION_FAILED",
    at: now,
    durationMs: 0,
    revision: buildRevision(),
    ...safe,
  };
}
export function saveSocialDiagnostic(
  store: SocialStore,
  runId: string,
  step: number,
  diagnostic: SocialDiagnostic,
) {
  store.exec(
    "INSERT INTO social_diagnostic VALUES (?,?,?) ON CONFLICT(run_id,step) DO UPDATE SET data=excluded.data",
    runId,
    step,
    JSON.stringify(diagnostic),
  );
}
export function recordActionFailure(
  store: SocialStore,
  run: SocialRun,
  diagnostic: SocialDiagnostic,
  context: Pick<ContactDiagnostic, "personaId" | "model" | "style">,
) {
  contactLog({
    ...context,
    requestId: diagnostic.requestId,
    operationId: run.requestId,
    operation: "social.action",
    stage: diagnostic.stage,
    outcome: "failed",
    durationMs: diagnostic.durationMs,
    level: "error",
    code: diagnostic.code,
    ...(diagnostic.causeCode && { causeCode: diagnostic.causeCode }),
    ...(diagnostic.causeName && { causeName: diagnostic.causeName }),
    ...(diagnostic.upstreamStatus && { upstreamStatus: diagnostic.upstreamStatus }),
    ...(diagnostic.stack && { stack: diagnostic.stack }),
  });
  const previous = store.exec<{ data: string }>(
    "SELECT data FROM social_diagnostic WHERE run_id=? AND step=?",
    run.id,
    run.step,
  )[0];
  if (previous && ["executor", "model", "recovery"].includes(diagnostic.stage)) {
    const prior = Schema.decodeUnknownSync(Schema.fromJsonString(SocialDiagnostic))(previous.data);
    diagnostic = {
      ...prior,
      ...diagnostic,
      stage: prior.submission === "verified" ? prior.stage : diagnostic.stage,
      submission: prior.submission === "verified" ? "verified" : diagnostic.submission,
      ...(prior.postId && !diagnostic.postId && { postId: prior.postId }),
      code: diagnostic.code,
      at: diagnostic.at,
      durationMs: Math.max(prior.durationMs, diagnostic.durationMs),
    };
  }
  saveSocialDiagnostic(store, run.id, run.step, diagnostic);
  return diagnostic;
}
export function recordRunFailure(
  store: SocialStore,
  run: SocialRun,
  state: string,
  now: number,
  provided?: SocialDiagnostic,
) {
  const prior = store.exec<{ state: string }>(
    "SELECT state FROM social_event WHERE run_id=? AND step=?",
    run.id,
    run.step,
  )[0];
  if (prior && ["failed", "uncertain"].includes(prior.state)) return;
  const personaId = store.config(store.account(run.accountId)!).personaId;
  store.exec(
    "INSERT INTO social_event(run_id,account_id,persona_id,at,kind,state,reason,text,input,step,contact,generation) VALUES (?,?,?,?,'execution','failed','Execution did not complete','','{}',?,?,?) ON CONFLICT(run_id,step) DO NOTHING",
    run.id,
    run.accountId,
    personaId,
    now,
    run.step,
    run.contact,
    run.generation,
  );
  recordActionFailure(
    store,
    run,
    provided ?? {
      requestId: run.requestId,
      stage: state === "interrupted" ? "recovery" : "model",
      submission: prior ? "attempted" : "not_attempted",
      code: state === "interrupted" ? "SOCIAL_RUN_INTERRUPTED" : "SOCIAL_RUN_FAILED",
      at: now,
      durationMs: 0,
      revision: buildRevision(),
    },
    { personaId },
  );
}
export function settleActionFailure(
  store: SocialStore,
  service: SocialService,
  action: {
    run: SocialRun;
    accountId: string;
    personaId: string;
    day: string;
    target: string | null;
    write: boolean;
    authRequired: boolean;
  },
  recorded: SocialDiagnostic,
) {
  const diagnostic = recorded;
  const notAttempted = diagnostic.submission === "not_attempted";
  store.transaction(() => {
    if (action.write && notAttempted) {
      store.exec(
        "UPDATE social_account SET writes=MAX(writes-1,0) WHERE id=? AND day=?",
        action.accountId,
        action.day,
      );
      store.exec(
        "DELETE FROM social_target WHERE account_id=? AND target=?",
        action.accountId,
        action.target,
      );
    }
    store.exec(
      "UPDATE social_event SET state=?,result=? WHERE run_id=? AND step=?",
      action.write && !notAttempted ? "uncertain" : "failed",
      action.authRequired
        ? JSON.stringify({ text: "not sent: social authentication required" })
        : null,
      action.run.id,
      action.run.step,
    );
  });
  service.complete(action.run.id, action.authRequired ? "login_required" : "failed");
}
