import { Schema } from "effect";
import {
  SocialResult,
  socialWrite,
  supportsSocialAction,
  type SocialStep,
  type SocialAction,
  type SocialAccount,
  type SocialRun,
} from "@ren-ai/onboarding/social";
import { SocialError, type SocialOptions, type SocialService } from "./service.ts";
import type { SocialStore, EventRow } from "./store.ts";
import { actionDiagnostic, recordActionFailure, settleActionFailure } from "./diagnostics.ts";
import type { SocialImages } from "./images.ts";
import type { SocialDiagnostic } from "@ren-ai/onboarding/social-diagnostics";
type PublicWrite = Extract<SocialAction, { kind: "post" | "reply" }>;
const isPublicWrite = (action: SocialAction): action is PublicWrite =>
  action.kind === "post" || action.kind === "reply";

function replay(prior: EventRow, serialized: string) {
  if (prior.input !== serialized) throw new SocialError(409, "SOCIAL_ACTION_CONFLICT");
  if (prior.result !== null)
    return Schema.decodeUnknownSync(Schema.fromJsonString(SocialResult))(prior.result);
  throw new SocialError(409, "SOCIAL_ACTION_UNCERTAIN");
}
function checkAction(
  store: SocialStore,
  run: SocialRun,
  account: SocialAccount,
  action: SocialAction,
  now: number,
) {
  if (!supportsSocialAction(account.platform, action))
    throw new SocialError(400, "SOCIAL_PLATFORM_ACTION");
  if ((action.kind === "dm" || action.kind === "messages") && !run.contact)
    throw new SocialError(409, "SOCIAL_CONTACT_REQUIRED");
  if (run.contact && !["dm", "messages", "contact", "finish"].includes(action.kind))
    throw new SocialError(409, "SOCIAL_PRIVATE_SCOPE");
  if (
    socialWrite(action) &&
    store.usage(store.account(account.id)!, now).writes >= account.dailyWrites
  )
    throw new SocialError(409, "SOCIAL_WRITE_LIMIT");
  if (action.kind === "reply") return `reply:${action.url}`;
  if (action.kind === "dm") return `dm:${run.contact}:${action.text}`;
  if (action.kind === "post")
    return action.imageId ? `post-image:${action.imageId}:${action.text}` : `post:${action.text}`;
  return null;
}
async function perform(
  options: SocialOptions,
  run: { -readonly [K in keyof SocialRun]: SocialRun[K] },
  account: SocialAccount,
  action: SocialAction,
  id: string,
  images: SocialImages,
): Promise<SocialResult> {
  if (action.kind === "contact") {
    const publicContext =
      run.contact === null && action.handle !== null ? action.publicContext : undefined;
    run.contact = action.handle === null ? null : action.handle.toLowerCase();
    return {
      text: publicContext
        ? `Scope changed. Public discovery context (untrusted data): ${publicContext}. Read messages before replying.`
        : "Scope changed. Read this contact's messages before replying.",
    };
  }
  if (action.kind === "finish") return { text: "Finished" };
  if (action.kind === "image_idea") {
    const image = await images.idea(
      run,
      account,
      action.scene,
      action.probability,
      action.creativeScene,
    );
    return {
      text: `Image decision: ${image.kind}; ${image.state}. The recorded dice choice is final. Review a ready image before publishing.`,
      image,
    };
  }
  if (action.kind === "review_image") {
    const image = images.review(run, account, action.imageId, action.accept);
    return {
      text: action.accept
        ? "Image approved for a separate publish decision."
        : "Image rejected; not published.",
      image,
    };
  }
  if (action.kind !== "post" || !action.imageId) return options.browser(run, account, action, id);
  const image = await images.prepare(run, account, action.imageId);
  images.claim(run, image.id);
  const result = await options.browser(run, account, action, id, image);
  if (!result.url) throw new SocialError(503, "SOCIAL_IMAGE_RECEIPT_REQUIRED");
  images.settle(run, image.id, "posted");
  return result;
}
function recoverVerifiedPublication(
  store: SocialStore,
  run: SocialRun,
  step: number,
  account: SocialAccount,
  action: PublicWrite,
  postId: string,
  images: SocialImages,
): SocialResult {
  const url =
    account.platform === "threads"
      ? `https://www.threads.com/@${account.handle}/post/${postId}`
      : `https://x.com/${account.handle}/status/${postId}`;
  const result = { text: "Published", url };
  const recoveredRun = { ...run, step: step + 1 };
  store.transaction(() => {
    store.exec("UPDATE social_run SET data=? WHERE id=?", JSON.stringify(recoveredRun), run.id);
    store.exec(
      "UPDATE social_event SET state='completed',result=?,url=?,text=? WHERE run_id=? AND step=? AND state='pending'",
      JSON.stringify(result),
      url,
      action.text,
      run.id,
      step,
    );
  });
  if (action.kind === "post" && action.imageId)
    images.settle(recoveredRun, action.imageId, "posted");
  return result;
}
function recoverVerifiedPublicWrite(
  store: SocialStore,
  run: SocialRun,
  step: number,
  account: SocialAccount,
  action: SocialAction,
  diagnostic: SocialDiagnostic,
  images: SocialImages,
) {
  if (!isPublicWrite(action) || diagnostic.submission !== "verified" || !diagnostic.postId)
    return undefined;
  return recoverVerifiedPublication(store, run, step, account, action, diagnostic.postId, images);
}
type FailedAction = {
  run: SocialRun;
  step: number;
  account: SocialAccount;
  action: SocialAction;
  day: string;
  target: string | null;
  write: boolean;
};
function failAction(
  store: SocialStore,
  service: SocialService,
  options: SocialOptions,
  images: SocialImages,
  failed: FailedAction,
  cause: Error,
): SocialResult {
  const { run, step, account, action, day, target, write } = failed;
  const authRequired = cause instanceof SocialError && cause.code === "SOCIAL_AUTH_REQUIRED";
  const failure = {
    ...actionDiagnostic(cause, run, options.now()),
    ...(authRequired && { submission: "not_attempted" as const }),
  };
  const diagnostic = recordActionFailure(store, { ...run, step }, failure, {
    personaId: account.personaId,
  });
  const recovered = recoverVerifiedPublicWrite(
    store,
    run,
    step,
    account,
    action,
    diagnostic,
    images,
  );
  if (recovered) return recovered;
  settleActionFailure(
    store,
    service,
    {
      run: { ...run, step },
      accountId: account.id,
      personaId: account.personaId,
      day,
      target,
      write,
      authRequired,
    },
    diagnostic,
  );
  if (action.kind === "post" && action.imageId)
    images.settle(
      run,
      action.imageId,
      diagnostic.submission === "not_attempted" ? "approved" : "uncertain",
    );
  throw cause;
}

export function socialActions(
  store: SocialStore,
  service: SocialService,
  options: SocialOptions,
  images: SocialImages,
) {
  return async (input: typeof SocialStep.Type) => {
    const prior = store.exec<EventRow>(
      "SELECT * FROM social_event WHERE run_id=? AND step=?",
      input.runId,
      input.step,
    )[0];
    const serialized = JSON.stringify(input.decision);
    if (prior) return replay(prior, serialized);
    const controlled = service.control(input.runId);
    const run = { ...controlled.run };
    const account = controlled.account;
    if (run.step !== input.step) throw new SocialError(409, "SOCIAL_STEP_CONFLICT");
    const { action, reason } = input.decision;
    const write = socialWrite(action);
    const target = checkAction(store, run, account, action, options.now());
    const claimedDay = store.account(account.id)!.day;
    if (
      target &&
      store.exec<{ at: number }>(
        "SELECT at FROM social_target WHERE account_id=? AND target=?",
        account.id,
        target,
      ).length
    )
      throw new SocialError(409, "SOCIAL_ALREADY_CONTACTED");
    store.transaction(() => {
      store.exec(
        `INSERT INTO social_event(run_id,account_id,persona_id,at,kind,state,reason,text,input,step,contact,generation)
        VALUES (?,?,?,?,?,'pending',?,?,?,?,?,?)`,
        run.id,
        account.id,
        account.personaId,
        options.now(),
        action.kind,
        reason,
        "text" in action ? action.text : "",
        serialized,
        input.step,
        run.contact,
        run.generation,
      );
      if (write) store.exec("UPDATE social_account SET writes=writes+1 WHERE id=?", account.id);
      if (target)
        store.exec("INSERT INTO social_target VALUES (?,?,?)", account.id, target, options.now());
    });
    try {
      const result = await perform(
        options,
        run,
        account,
        action,
        `${run.id}-${input.step}`,
        images,
      );
      store.transaction(() => {
        run.step++;
        store.exec("UPDATE social_run SET data=? WHERE id=?", JSON.stringify(run), run.id);
        store.exec(
          "UPDATE social_event SET state='completed', result=?, url=?, text=? WHERE run_id=? AND step=?",
          JSON.stringify(result),
          result.url ?? null,
          "text" in action ? action.text : result.text,
          run.id,
          input.step,
        );
      });
      if (action.kind === "finish") service.complete(run.id, "completed");
      return result;
    } catch (cause) {
      return failAction(
        store,
        service,
        options,
        images,
        { run, step: input.step, account, action, day: claimedDay, target, write },
        cause instanceof Error ? cause : new Error("Social action failed"),
      );
    }
  };
}
