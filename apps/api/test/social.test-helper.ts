import { DatabaseSync } from "node:sqlite";
import { fromPartial } from "@total-typescript/shoehorn";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { Schema } from "effect";
import {
  SocialSnapshot,
  type SocialAccount,
  type SocialAction,
  type SocialRun,
} from "@ren-ai/onboarding/social";
import { createSocial } from "../src/social/http.ts";
import type { SocialOptions } from "../src/social/service.ts";
import { socialAccount } from "../../../packages/onboarding/src/social.test-helper.ts";
export { socialAccount };
export function socialGate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function socialFixture() {
  const db = new DatabaseSync(":memory:");
  let alarm: number | null = null;
  const queries: string[] = [];
  const storage = fromPartial<DurableObjectStorage>({
    sql: {
      exec: (query: string, ...bindings: (string | number | null)[]) => {
        queries.push(query);
        const rows = db.prepare(query).all(...bindings);
        return { toArray: () => rows };
      },
    },
    transactionSync: <T>(run: () => T) => {
      db.exec("BEGIN");
      try {
        const result = run();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    getAlarm: async () => alarm,
    setAlarm: async (at: number | Date) => {
      alarm = Number(at);
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  });
  let now = Date.parse("2026-10-30T03:00:00Z");
  const started: string[] = [];
  const runs: SocialRun[] = [];
  const writes: SocialAction[] = [];
  const options: SocialOptions = {
    token: "secret",
    now: () => now,
    personas: async () => new Set(["alice", "bob"]),
    invitation: async () => true,
    start: async (run) => {
      started.push(run.id);
      runs.push(run);
    },
    cancel: async () => {},
    open: async () => {},
    browser: async (_run, _account, action) => {
      writes.push(action);
      return { text: "observed" };
    },
  };
  const app = createSocial(storage, options);
  const request = (path = "", body?: object, method = body ? "POST" : "GET") =>
    app.fetch(
      new Request(`https://api.test/management/social${path}`, {
        method,
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        ...(body && { body: JSON.stringify(body) }),
      }),
    );
  const snapshot = async () =>
    Schema.decodeUnknownSync(SocialSnapshot)(await (await request()).json());
  const action = (step: number, operation: SocialAction, reason = "Relevant conversation") =>
    request("/actions", { runId: started[0], step, decision: { action: operation, reason } });
  const enable = async (overrides: Partial<SocialAccount> = {}) => {
    await request("/accounts", { ...socialAccount, enabled: true, ...overrides });
    await app.alarm();
  };
  return {
    db,
    queries,
    request,
    snapshot,
    action,
    enable,
    started,
    runs,
    writes,
    options,
    storage,
    app,
    alarm: () => alarm,
    advance: (ms: number) => {
      now += ms;
    },
    close: () => db.close(),
  };
}
