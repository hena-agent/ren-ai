import { randomUUID } from "node:crypto";
import {
  nextSocialTime,
  socialTime,
  type SocialAccount,
  type SocialRun,
  type SocialResult,
} from "@ren-ai/onboarding/social";
import type { SocialStore, AccountRow } from "./store.ts";

export class SocialError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export interface SocialOptions {
  token: string;
  now: () => number;
  personas: () => Promise<ReadonlySet<string>>;
  invitation: (code: string) => Promise<boolean>;
  start: (run: SocialRun, account: SocialAccount) => Promise<void>;
  cancel: (accountId: string, runId: string) => Promise<void>;
  open: (accountId: string) => Promise<void>;
  browser: (
    run: SocialRun,
    account: SocialAccount,
    action: import("@ren-ai/onboarding/social").SocialAction,
    id: string,
  ) => Promise<SocialResult>;
}
async function validateConfiguration(
  account: SocialAccount,
  options: SocialOptions,
  prior: SocialAccount | undefined,
) {
  if (account.startHour >= account.endHour) throw new SocialError(400, "SOCIAL_WINDOW");
  socialTime(account, options.now());
  const unchangedIdentity =
    prior?.personaId === account.personaId && prior.invitation === account.invitation;
  if (account.enabled || !unchangedIdentity) {
    if (!(await options.personas()).has(account.personaId))
      throw new SocialError(400, "SOCIAL_PERSONA_NOT_FOUND");
    if (!(await options.invitation(account.invitation)))
      throw new SocialError(409, "SOCIAL_INVITATION_UNAVAILABLE");
  }
}

export function socialService(store: SocialStore, options: SocialOptions) {
  const finishConfiguration = (account: SocialAccount) => {
    if (store.account(account.id)?.config !== JSON.stringify(account)) return;
    store.exec(
      "UPDATE social_account SET next_at=?, state=? WHERE id=?",
      account.enabled ? nextSocialTime(account, options.now()) : null,
      account.enabled ? "scheduled" : "paused",
      account.id,
    );
  };
  const stop = async (row: AccountRow) => {
    const running = store.exec<{ id: string }>(
      "SELECT id FROM social_run WHERE account_id=? AND state='running' LIMIT 1",
      row.id,
    )[0];
    store.exec(
      "UPDATE social_run SET state = 'stopped' WHERE account_id = ? AND state = 'running'",
      row.id,
    );
    store.exec(
      "UPDATE social_event SET state = 'uncertain' WHERE account_id = ? AND state = 'pending'",
      row.id,
    );
    if (running) await options.cancel(row.id, running.id);
  };
  const configure = async (account: SocialAccount) => {
    const prior = store.account(account.id);
    await validateConfiguration(account, options, prior ? store.config(prior) : undefined);
    if (store.account(account.id)?.config !== prior?.config)
      throw new SocialError(409, "SOCIAL_CONFIGURATION_CHANGED");
    if (
      !prior &&
      store.exec<{ id: string }>("SELECT id FROM social_account LIMIT 100").length >= 100
    )
      throw new SocialError(409, "SOCIAL_ACCOUNT_LIMIT");
    const duplicate = store.exec<{ id: string }>(
      "SELECT id FROM social_account WHERE lower(json_extract(config, '$.handle')) = lower(?) AND id != ? LIMIT 1",
      account.handle,
      account.id,
    );
    if (duplicate.length) throw new SocialError(409, "SOCIAL_ACCOUNT_ALREADY_CONNECTED");
    if (prior?.config === JSON.stringify(account)) return;
    // Persist the fence before any remote cancellation; old work cannot publish while reassigning.
    const reassigned =
      prior &&
      (store.config(prior).personaId !== account.personaId ||
        store.config(prior).handle !== account.handle);
    const generation = (prior?.generation ?? 1) + (reassigned ? 1 : 0);
    store.exec(
      `INSERT INTO social_account VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET config=excluded.config, generation=excluded.generation,
      next_at=excluded.next_at, state=excluded.state`,
      account.id,
      JSON.stringify(account),
      generation,
      options.now() + 30000,
      "changing",
      socialTime(account, options.now()).day,
      0,
      0,
    );
    await store.arm();
    try {
      if (prior) await stop(prior);
    } finally {
      finishConfiguration(account);
    }
  };
  const control = (id: string) => {
    const row = store.run(id);
    if (!row || row.state !== "running") throw new SocialError(409, "SOCIAL_RUN_STOPPED");
    const run = store.decodeRun(row);
    const record = store.account(run.accountId)!;
    const account = store.config(record);
    if (
      !account.enabled ||
      record.generation !== run.generation ||
      run.deadline <= options.now() ||
      !socialTime(account, options.now()).active
    )
      throw new SocialError(409, "SOCIAL_RUN_STOPPED");
    const history = JSON.stringify(
      store.exec<{ kind: string; state: string; text: string; url: string | null }>(
        "SELECT kind,state,substr(text,1,200) AS text,url FROM social_event WHERE account_id=? AND generation=? AND contact IS ? ORDER BY id DESC LIMIT 10",
        account.id,
        run.generation,
        run.contact,
      ),
    );
    return { run, account, history };
  };
  const complete = (id: string, state: string) => {
    const row = store.run(id);
    if (!row || row.state !== "running") return;
    const run = store.decodeRun(row);
    const accountRow = store.account(run.accountId)!;
    const account = store.config(accountRow);
    store.exec("UPDATE social_run SET state = ? WHERE id = ?", state, id);
    store.exec(
      "UPDATE social_event SET state = 'uncertain' WHERE run_id = ? AND state = 'pending'",
      id,
    );
    if (accountRow.generation === run.generation)
      store.exec(
        "UPDATE social_account SET state = ?, next_at = ? WHERE id = ?",
        state,
        account.enabled
          ? nextSocialTime(account, options.now() + account.intervalMinutes * 60_000)
          : null,
        account.id,
      );
  };
  const alarm = async () => {
    const now = options.now();
    const rows = store.exec<AccountRow>(
      "SELECT * FROM social_account WHERE next_at <= ? ORDER BY next_at, id LIMIT 5",
      now,
    );
    for (const row of rows) {
      const account = store.config(row);
      const running = store.exec<{ id: string; data: string; state: string }>(
        "SELECT id,data,state FROM social_run WHERE state = 'running' AND account_id = ? LIMIT 1",
        row.id,
      )[0];
      if (running) {
        complete(running.id, "interrupted");
        await options.cancel(row.id, running.id);
        continue;
      }
      if (!account.enabled) {
        store.exec("UPDATE social_account SET next_at=NULL, state='paused' WHERE id=?", row.id);
        continue;
      }
      const usage = store.usage(row, now);
      if (!socialTime(account, now).active || usage.turns >= account.dailyTurns) {
        store.exec(
          "UPDATE social_account SET next_at = ? WHERE id = ?",
          nextSocialTime(account, now, usage.turns >= account.dailyTurns),
          row.id,
        );
        continue;
      }
      const run: SocialRun = {
        id: randomUUID(),
        accountId: row.id,
        generation: row.generation,
        requestId: randomUUID(),
        deadline: now + account.runMinutes * 60_000,
        contact: null,
        step: 0,
      };
      store.transaction(() => {
        store.exec(
          "INSERT INTO social_run VALUES (?, ?, ?, 'running')",
          run.id,
          row.id,
          JSON.stringify(run),
        );
        store.exec(
          "UPDATE social_account SET state='running', next_at=? WHERE id=?",
          run.deadline,
          row.id,
        );
      });
      // Save recovery wake before crossing the Mac boundary.
      await store.arm();
      try {
        if (!(await options.personas()).has(account.personaId))
          throw new SocialError(409, "SOCIAL_PERSONA_NOT_FOUND");
        if (!(await options.invitation(account.invitation)))
          throw new SocialError(409, "SOCIAL_INVITATION_UNAVAILABLE");
        await options.start(run, account);
      } catch (cause) {
        complete(run.id, "failed");
        throw cause;
      }
    }
  };
  return { configure, control, complete, alarm };
}
export type SocialService = ReturnType<typeof socialService>;
