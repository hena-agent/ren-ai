import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { Schema } from "effect";
import {
  SocialAccount,
  SocialRun,
  SocialEvent,
  socialTime,
  type SocialSnapshot,
} from "@ren-ai/onboarding/social";
import { SocialDiagnostic } from "@ren-ai/onboarding/social-diagnostics";

export type SocialStorage = Pick<
  DurableObjectStorage,
  "sql" | "transactionSync" | "setAlarm" | "getAlarm" | "deleteAlarm"
>;
export type AccountRow = {
  id: string;
  config: string;
  generation: number;
  next_at: number | null;
  state: string;
  day: string;
  turns: number;
  writes: number;
};
export type RunRow = { id: string; data: string; state: string };
export type EventRow = {
  id: number;
  run_id: string;
  account_id: string;
  persona_id: string;
  at: number;
  kind: string;
  state: "pending" | "completed" | "uncertain" | "failed";
  reason: string;
  text: string;
  url: string | null;
  input: string;
  result: string | null;
};
const config = (row: AccountRow) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(SocialAccount))(row.config);
const decodeRun = (row: RunRow) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(SocialRun))(row.data);

export function socialStore(storage: SocialStorage) {
  const exec = <T extends Record<string, string | number | null>>(
    query: string,
    ...values: (string | number | null)[]
  ) => storage.sql.exec<T>(query, ...values).toArray();
  exec(`CREATE TABLE IF NOT EXISTS social_account (
    id TEXT PRIMARY KEY, config TEXT NOT NULL, generation INTEGER NOT NULL,
    next_at INTEGER, state TEXT NOT NULL, day TEXT NOT NULL, turns INTEGER NOT NULL, writes INTEGER NOT NULL)`);
  exec("CREATE INDEX IF NOT EXISTS social_due ON social_account(next_at, id)");
  exec(
    "CREATE TABLE IF NOT EXISTS social_run (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL)",
  );
  exec("CREATE INDEX IF NOT EXISTS social_running ON social_run(account_id,state)");
  exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS social_one_run ON social_run(account_id) WHERE state='running'",
  );
  exec(
    "CREATE TABLE IF NOT EXISTS social_turn (run_id TEXT NOT NULL, step INTEGER NOT NULL, PRIMARY KEY(run_id,step))",
  );
  exec(`CREATE TABLE IF NOT EXISTS social_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, account_id TEXT NOT NULL,
    persona_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
    reason TEXT NOT NULL, text TEXT NOT NULL, url TEXT, input TEXT NOT NULL, result TEXT, contact TEXT, generation INTEGER NOT NULL,
    step INTEGER NOT NULL, UNIQUE(run_id, step))`);
  exec("CREATE INDEX IF NOT EXISTS social_account_events ON social_event(account_id, id)");
  exec("CREATE INDEX IF NOT EXISTS social_pending ON social_event(account_id, state)");
  exec(
    "CREATE TABLE IF NOT EXISTS social_diagnostic (run_id TEXT NOT NULL, step INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,step))",
  );
  exec(
    "CREATE TABLE IF NOT EXISTS social_image (id TEXT PRIMARY KEY,account_id TEXT NOT NULL,persona_id TEXT NOT NULL,generation INTEGER NOT NULL,run_id TEXT NOT NULL,step INTEGER NOT NULL,data TEXT NOT NULL,scene TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,due INTEGER,seen_run TEXT,paid INTEGER NOT NULL DEFAULT 0,UNIQUE(run_id,step),UNIQUE(account_id,generation,fingerprint))",
  );
  exec("CREATE INDEX IF NOT EXISTS social_image_owner ON social_image(account_id,generation)");
  exec("CREATE INDEX IF NOT EXISTS social_image_due ON social_image(due)");
  exec("CREATE INDEX IF NOT EXISTS social_image_state ON social_image(state)");
  exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS social_image_active ON social_image(account_id) WHERE state IN ('queued','generating','ready','approved','publishing')",
  );
  exec(
    "CREATE TABLE IF NOT EXISTS social_image_budget (account_id TEXT PRIMARY KEY,spent INTEGER NOT NULL)",
  );
  exec(
    "CREATE TABLE IF NOT EXISTS social_image_global_budget (id INTEGER PRIMARY KEY CHECK(id=1),spent INTEGER NOT NULL,approved INTEGER NOT NULL DEFAULT 0)",
  );
  exec(
    "INSERT INTO social_image_global_budget(id,spent,approved) VALUES(1,0,0) ON CONFLICT(id) DO NOTHING",
  );
  exec(
    "CREATE INDEX IF NOT EXISTS social_scope_events ON social_event(account_id, generation, contact, id)",
  );
  exec(
    "CREATE TABLE IF NOT EXISTS social_target (account_id TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(account_id,target))",
  );
  const account = (id: string) =>
    exec<AccountRow>("SELECT * FROM social_account WHERE id = ?", id)[0];
  const run = (id: string) => exec<RunRow>("SELECT * FROM social_run WHERE id = ?", id)[0];
  return {
    exec,
    refreshImageAllowance: () =>
      storage.transactionSync(() => {
        const approved = exec<{ approved: number }>(
          "SELECT COALESCE(SUM(json_extract(config,'$.images.credits')),0) AS approved FROM social_account WHERE json_type(config,'$.images')='object'",
        )[0]!.approved;
        exec("UPDATE social_image_global_budget SET approved=MAX(spent,?) WHERE id=1", approved);
      }),
    account,
    config,
    run,
    decodeRun,
    transaction: storage.transactionSync.bind(storage),
    usage: (row: AccountRow, now: number) => {
      const day = socialTime(config(row), now).day;
      if (row.day !== day) {
        exec("UPDATE social_account SET day = ?, turns = 0, writes = 0 WHERE id = ?", day, row.id);
        return { ...row, day, turns: 0, writes: 0 };
      }
      return row;
    },
    snapshot: (before: number): SocialSnapshot => ({
      imageAllowance: {
        spent: exec<{ spent: number }>(
          "SELECT spent FROM social_image_global_budget WHERE id=1",
        )[0]!.spent,
        approved: exec<{ approved: number }>(
          "SELECT approved FROM social_image_global_budget WHERE id=1",
        )[0]!.approved,
      },
      accounts: exec<AccountRow & { image_spent: number }>(
        "SELECT a.*,COALESCE(b.spent,0) AS image_spent FROM social_account a LEFT JOIN social_image_budget b ON b.account_id=a.id ORDER BY a.id LIMIT 100",
      ).map((row) => ({
        account: config(row),
        generation: row.generation,
        nextAt: row.next_at,
        state: row.state,
        turns: row.turns,
        writes: row.writes,
        imageSpent: row.image_spent,
      })),
      events: exec<EventRow & { diagnostic: string | null }>(
        "SELECT e.*,d.data AS diagnostic FROM social_event e LEFT JOIN social_diagnostic d ON d.run_id=e.run_id AND d.step=e.step WHERE e.id < ? ORDER BY e.id DESC LIMIT 50",
        before,
      ).map((row) =>
        Schema.decodeUnknownSync(SocialEvent)({
          id: row.id,
          runId: row.run_id,
          accountId: row.account_id,
          personaId: row.persona_id,
          at: row.at,
          kind: row.kind,
          state: row.state,
          reason: row.reason,
          text: row.text,
          url: row.url,
          ...(row.diagnostic && {
            diagnostic: Schema.decodeUnknownSync(Schema.fromJsonString(SocialDiagnostic))(
              row.diagnostic,
            ),
          }),
        }),
      ),
      before:
        exec<{ id: number }>(
          "SELECT id FROM social_event WHERE id < ? ORDER BY id DESC LIMIT 1 OFFSET 49",
          before,
        )[0]?.id ?? null,
    }),
    arm: async () => {
      const due = exec<{ due: number | null }>(
        `SELECT MIN(due) AS due FROM (SELECT MIN(next_at) AS due FROM social_account UNION ALL SELECT MIN(due) AS due FROM social_image WHERE due IS NOT NULL AND (state<>'queued' OR NOT EXISTS(SELECT 1 FROM social_image WHERE state='generating'))) `,
      )[0]!.due;
      if (due === null) {
        if ((await storage.getAlarm()) !== null) await storage.deleteAlarm();
      } else if ((await storage.getAlarm()) !== due) await storage.setAlarm(due);
    },
  };
}
export type SocialStore = ReturnType<typeof socialStore>;
