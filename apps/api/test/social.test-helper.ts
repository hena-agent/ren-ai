import { DatabaseSync } from "node:sqlite";
import { fromPartial } from "@total-typescript/shoehorn";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { Schema } from "effect";
import { afterEach, beforeEach, vi } from "vitest";
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
export function socialTestContext() {
  const fixtures: ReturnType<typeof socialFixture>[] = [];
  const logs: string[] = [];
  beforeEach(() => {
    for (const stream of [process.stdout, process.stderr])
      vi.spyOn(stream, "write").mockImplementation((text) => {
        logs.push(String(text));
        return true;
      });
  });
  afterEach(() => {
    fixtures.splice(0).forEach((f) => f.close());
    logs.length = 0;
    vi.restoreAllMocks();
  });
  return {
    logs,
    fixture: (overrides: Partial<SocialOptions> = {}) => {
      const f = socialFixture(overrides);
      fixtures.push(f);
      return f;
    },
  };
}
export function socialGate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function socialFixture(serviceOverrides: Partial<SocialOptions>) {
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
    authenticate: async () => ({ state: "not_configured", hasCredentials: false }),
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
    ...serviceOverrides,
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
