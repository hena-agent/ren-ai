import { Schema } from "effect";
import {
  SocialResult,
  socialWrite,
  type SocialStep,
  type SocialAction,
  type SocialAccount,
  type SocialRun,
} from "@ren-ai/onboarding/social";
import { SocialError, type SocialOptions, type SocialService } from "./service.ts";
import type { SocialStore, EventRow } from "./store.ts";

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
  if (action.kind === "post") return `post:${action.text}`;
  return null;
}
async function perform(
  options: SocialOptions,
  run: { -readonly [K in keyof SocialRun]: SocialRun[K] },
  account: SocialAccount,
  action: SocialAction,
  id: string,
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
  return options.browser(run, account, action, id);
}

export function socialActions(store: SocialStore, service: SocialService, options: SocialOptions) {
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
      const result = await perform(options, run, account, action, `${run.id}-${input.step}`);
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
      store.exec(
        "UPDATE social_event SET state=? WHERE run_id=? AND step=?",
        write ? "uncertain" : "failed",
        run.id,
        input.step,
      );
      service.complete(run.id, "failed");
      throw cause;
    }
  };
}
