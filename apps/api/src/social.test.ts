import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSocial } from "./social/http.ts";
import { Schema } from "effect";
import { SocialControl, SocialSnapshot } from "@ren-ai/onboarding/social";
import { socialFixture, socialGate, socialAccount as account } from "../test/social.test-helper.ts";
const fixtures: ReturnType<typeof socialFixture>[] = [];
const logs: string[] = [];
const fixture = () => {
  const f = socialFixture();
  fixtures.push(f);
  return f;
};
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

test("Admin assigns an X account to a chosen Persona and a replacement actor keeps its schedule", async () => {
  const f = fixture();
  expect((await f.request("/accounts", account)).status).toBe(200);
  expect((await f.snapshot()).accounts[0]?.account.personaId).toBe("alice");
  expect((await f.request("/accounts", { ...account, enabled: true })).status).toBe(200);
  await createSocial(f.storage, f.options).alarm();
  expect(f.started).toHaveLength(1);
  expect((await f.snapshot()).accounts[0]?.state).toBe("running");
  expect((await f.request("/accounts", { ...account, personaId: "bob" })).status).toBe(200);
  const next = (await f.snapshot()).accounts[0]!;
  expect(next.account.personaId).toBe("bob");
  expect(next.generation).toBe(2);
  expect(next.state).toBe("paused");
  expect((await f.request("/control", { runId: f.started[0] })).status).toBe(409);
});

test("public discovery and private DM actions are scoped, persisted and replayed without another browser call", async () => {
  const f = fixture();
  await f.enable();
  const search = { kind: "search", query: "character.ai memory" } as const;
  expect((await f.action(0, search)).status).toBe(200);
  expect((await f.action(0, search)).status).toBe(200);
  expect(f.writes).toHaveLength(1);
  expect((await f.action(0, { kind: "notifications" })).status).toBe(409);
  expect((await f.action(3, search)).status).toBe(409);
  expect((await f.action(1, { kind: "dm", text: "hello" })).status).toBe(409);
  expect((await f.action(1, { kind: "contact", handle: "reader" })).status).toBe(200);
  expect((await f.action(2, search)).status).toBe(409);
  expect((await f.action(2, { kind: "messages" })).status).toBe(200);
  expect((await f.action(3, { kind: "dm", text: "Want to try RenAI?" })).status).toBe(200);
  expect((await f.action(4, { kind: "dm", text: "Want to try RenAI?" })).status).toBe(409);
  expect((await f.action(4, { kind: "contact", handle: null })).status).toBe(200);
  expect((await f.action(5, { kind: "post", text: "A public thought" })).status).toBe(200);
  expect(
    (
      await f.action(6, {
        kind: "reply",
        url: "https://x.com/reader/status/123",
        text: "Interesting!",
      })
    ).status,
  ).toBe(200);
  expect(
    (await f.action(7, { kind: "reply", url: "https://x.com/reader/status/123", text: "Again" }))
      .status,
  ).toBe(409);
  expect((await f.action(7, { kind: "finish" })).status).toBe(200);
  expect((await f.action(7, { kind: "finish" })).status).toBe(200);
  const snapshot = await f.snapshot();
  expect(snapshot.accounts[0]).toMatchObject({ state: "completed", writes: 3 });
  expect(snapshot.events[0]).toMatchObject({ kind: "finish", state: "completed" });
  expect(snapshot.events.find((event) => event.kind === "search")?.text).toBe("observed");
});

test("simultaneous requests cannot duplicate a pending send; actor replacement preserves uncertainty", async () => {
  const f = fixture();
  await f.enable();
  const { promise: pending, resolve: release } = socialGate<void>();
  f.options.browser = async () => {
    await pending;
    throw Object.assign(new Error("PRIVATE_TEXT secret"), { code: "BROWSER_DISCONNECTED" });
  };
  const first = f.action(0, { kind: "post", text: "PRIVATE_TEXT" });
  await vi.waitFor(() =>
    expect(f.db.prepare("SELECT state FROM social_event").get()).toMatchObject({
      state: "pending",
    }),
  );
  expect((await f.action(0, { kind: "post", text: "PRIVATE_TEXT" })).status).toBe(409);
  release();
  const failed = await first;
  expect(failed.status).toBe(503);
  const replacement = createSocial(f.storage, f.options);
  const replay = await replacement.fetch(
    new Request("https://api.test/management/social/actions", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
      body: JSON.stringify({
        runId: f.started[0],
        step: 0,
        decision: {
          action: { kind: "post", text: "PRIVATE_TEXT" },
          reason: "Relevant conversation",
        },
      }),
    }),
  );
  expect(replay.status).toBe(409);
  expect((await f.snapshot()).events[0]?.state).toBe("uncertain");
  expect(logs.join("")).toContain("BROWSER_DISCONNECTED");
  expect(logs.join("")).not.toContain("PRIVATE_TEXT");
  expect(logs.join("")).not.toContain("secret");
  expect(failed.headers.get("x-request-id")).toBeTruthy();
});

test("turn reservations are idempotent and daily limits survive repeated runs and reset on the local day", async () => {
  const f = fixture();
  await f.enable({ dailyTurns: 1, dailyWrites: 1 });
  const body = { runId: f.started[0] };
  expect((await f.request("/turn", body)).status).toBe(200);
  expect((await f.request("/turn", body)).status).toBe(200);
  expect((await f.snapshot()).accounts[0]?.turns).toBe(1);
  expect((await f.action(0, { kind: "post", text: "one" })).status).toBe(200);
  expect((await f.action(1, { kind: "post", text: "two" })).status).toBe(409);
  expect((await f.request("/turn", body)).status).toBe(409);
  await f.request("/complete", { ...body, state: "completed" });
  f.advance(31 * 60_000);
  await f.app.alarm();
  expect(f.started).toHaveLength(1);
  f.advance(24 * 60 * 60_000);
  await f.app.alarm();
  expect(f.started).toHaveLength(2);
  expect((await f.snapshot()).accounts[0]).toMatchObject({ turns: 0, writes: 0 });
});

test("window boundaries, expired leases and failed dispatches keep durable bounded recovery", async () => {
  const f = fixture();
  await f.enable();
  f.advance(6 * 60_000);
  expect((await f.request("/control", { runId: f.started[0] })).status).toBe(409);
  await f.app.alarm();
  expect((await f.snapshot()).accounts[0]?.state).toBe("interrupted");
  f.advance(31 * 60_000);
  f.options.start = async () => {
    throw new Error("executor down");
  };
  await f.app.alarm();
  expect((await f.snapshot()).accounts[0]?.state).toBe("failed");
  expect(f.alarm()).toBeGreaterThan(f.options.now());
  f.advance(12 * 60 * 60_000);
  await f.request("/now", { accountId: account.id });
  await f.app.alarm();
  expect(f.alarm()).toBeGreaterThan(f.options.now());
  const before = f.queries.length;
  await f.app.alarm();
  expect(f.queries.slice(before).filter((sql) => /UPDATE|INSERT|DELETE/.test(sql))).toEqual([]);
  expect(
    JSON.stringify(
      f.db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM social_account WHERE next_at <= 0 ORDER BY next_at, id LIMIT 5",
        )
        .all(),
    ),
  ).toContain("social_due");
});

test("invalid, unavailable and conflicting configurations are refused and an exhausted invitation never prevents stopping", async () => {
  const f = fixture();
  for (const change of [
    { startHour: 22, endHour: 9 },
    { personaId: "missing" },
    { timeZone: "invalid" },
  ])
    expect((await f.request("/accounts", { ...account, ...change })).status).toBeGreaterThanOrEqual(
      400,
    );
  f.options.invitation = async () => false;
  expect((await f.request("/accounts", account)).status).toBe(409);
  f.options.invitation = async () => true;
  await f.enable();
  expect(
    (await f.request("/accounts", { ...account, id: "other", handle: "PERSONA_X" })).status,
  ).toBe(409);
  f.options.invitation = async () => false;
  expect((await f.request("/accounts", account)).status).toBe(200);
  expect((await f.request("/accounts", account)).status).toBe(200);
  expect((await f.snapshot()).accounts[0]?.state).toBe("paused");
});

test("authenticated operators can open Canary and request work; malformed and unauthorized requests stay inert", async () => {
  const f = fixture();
  expect((await f.app.fetch(new Request("https://app/management/social"))).status).toBe(401);
  expect((await f.request("", undefined, "DELETE")).status).toBe(405);
  expect((await f.request("/missing", {})).status).toBe(404);
  expect((await f.request("?before=bad")).status).toBe(400);
  expect((await f.request("/accounts", { bad: true })).status).toBe(400);
  expect((await f.request("/accounts", { instructions: "x".repeat(33000) })).status).toBe(413);
  expect((await f.request("/open", { accountId: "missing" })).status).toBe(404);
  await f.request("/accounts", account);
  expect((await f.request("/open", { accountId: account.id })).status).toBe(204);
  expect((await f.request("/now", { accountId: account.id })).status).toBe(409);
  await f.enable();
  expect((await f.request("/now", { accountId: account.id })).status).toBe(409);
  await f.request("/complete", { runId: f.started[0], state: "completed" });
  expect((await f.request("/now", { accountId: account.id })).status).toBe(204);
  expect((await f.request("/complete", { runId: f.started[0], state: "completed" })).status).toBe(
    204,
  );
  expect((await f.request("/complete", { runId: "missing", state: "failed" })).status).toBe(204);
});

test("private context never travels into public activity or a replacement Persona's activity history", async () => {
  const f = fixture();
  await f.enable();
  const entered = await f.action(0, {
    kind: "contact",
    handle: "Reader",
    publicContext: "A public post about memory",
  });
  expect(JSON.stringify(await entered.json())).toContain("public post about memory");
  f.options.browser = async () => ({ text: "PRIVATE_READER_FACT" });
  await f.action(1, { kind: "messages" });
  const privateControl = Schema.decodeUnknownSync(SocialControl)(
    await (await f.request("/control", { runId: f.started[0] })).json(),
  );
  expect(privateControl.run.contact).toBe("reader");
  expect(privateControl.history).toContain("PRIVATE_READER_FACT");
  const returned = await f.action(2, {
    kind: "contact",
    handle: null,
    publicContext: "PRIVATE_READER_FACT",
  });
  expect(JSON.stringify(await returned.json())).not.toContain("PRIVATE_READER_FACT");
  const publicControl = Schema.decodeUnknownSync(SocialControl)(
    await (await f.request("/control", { runId: f.started[0] })).json(),
  );
  expect(publicControl.history).not.toContain("PRIVATE_READER_FACT");
  f.options.browser = async () => ({
    text: "Published",
    url: "https://x.com/persona_x/status/456",
  });
  await f.action(3, { kind: "post", text: "A thought" });
  await f.request("/accounts", { ...account, personaId: "bob", enabled: true });
  await f.app.alarm();
  await f.request("/actions", {
    runId: f.started[1],
    step: 0,
    decision: { action: { kind: "contact", handle: "reader" }, reason: "New scope" },
  });
  const next = Schema.decodeUnknownSync(SocialControl)(
    await (await f.request("/control", { runId: f.started[1] })).json(),
  );
  expect(next.history).not.toContain("PRIVATE_READER_FACT");
  expect(next.history).not.toContain("A thought");
});

test("late completions cannot overwrite a changed assignment, and pausing never leaves a recovery alarm spinning", async () => {
  for (const replacement of ["bob", "alice"]) {
    const f = fixture();
    await f.enable();
    const hold = socialGate<number | null>();
    vi.spyOn(f.storage, "getAlarm").mockImplementationOnce(() => hold.promise);
    const change = f.request("/accounts", { ...account, personaId: replacement, enabled: false });
    await vi.waitFor(() =>
      expect(f.db.prepare("SELECT state FROM social_account").get()).toMatchObject({
        state: "changing",
      }),
    );
    expect((await f.request("/control", { runId: f.started[0] })).status).toBe(409);
    await f.request("/complete", { runId: f.started[0], state: "completed" });
    hold.resolve(null);
    expect((await change).status).toBe(200);
    expect((await f.snapshot()).accounts[0]).toMatchObject({
      account: { personaId: replacement },
      state: "paused",
      nextAt: null,
    });
    expect(f.alarm()).toBeNull();
  }
  const stale = fixture();
  const hold = socialGate<number | null>();
  vi.spyOn(stale.storage, "getAlarm").mockImplementationOnce(() => hold.promise);
  const configuring = stale.request("/accounts", account);
  await vi.waitFor(() =>
    expect(stale.db.prepare("SELECT state FROM social_account").get()).toMatchObject({
      state: "changing",
    }),
  );
  stale.advance(31000);
  await createSocial(stale.storage, stale.options).alarm();
  hold.resolve(null);
  await configuring;
  expect(stale.alarm()).toBeNull();
});

test("concurrent configuration and delayed cancellation cannot clobber the latest account connection", async () => {
  const f = fixture();
  const hold = socialGate<ReadonlySet<string>>();
  const personas = vi
    .fn<typeof f.options.personas>()
    .mockReturnValueOnce(hold.promise)
    .mockResolvedValue(new Set(["alice", "bob"]));
  f.options.personas = personas;
  const first = f.request("/accounts", account);
  await vi.waitFor(() => expect(personas).toHaveBeenCalledOnce());
  expect((await f.request("/accounts", { ...account, personaId: "bob" })).status).toBe(200);
  hold.resolve(new Set(["alice", "bob"]));
  expect((await first).status).toBe(409);
  await f.request("/accounts", { ...account, enabled: true });
  await f.app.alarm();
  const canceled = socialGate<void>();
  f.options.cancel = vi.fn<typeof f.options.cancel>(async () => canceled.promise);
  const changing = f.request("/accounts", { ...account, personaId: "bob", enabled: true });
  await vi.waitFor(() => expect(f.options.cancel).toHaveBeenCalledOnce());
  await f.request("/accounts", { ...account, handle: "new_handle", enabled: false });
  canceled.resolve();
  await changing;
  expect((await f.snapshot()).accounts[0]?.account).toMatchObject({
    personaId: "alice",
    handle: "new_handle",
    enabled: false,
  });
});

test("dispatch rechecks Catalog and invitation availability, and reads fail without an uncertain-write claim", async () => {
  for (const missing of ["persona", "invitation"]) {
    const f = fixture();
    await f.request("/accounts", { ...account, enabled: true });
    if (missing === "persona") f.options.personas = async () => new Set();
    else f.options.invitation = async () => false;
    await f.app.alarm();
    expect((await f.snapshot()).accounts[0]?.state).toBe("failed");
  }
  const f = fixture();
  await f.enable();
  f.options.browser = async () => {
    throw new Error("read failed");
  };
  expect((await f.action(0, { kind: "search", query: "a" })).status).toBe(503);
  expect((await f.snapshot()).events[0]?.state).toBe("failed");
  const late = fixture();
  late.advance((9 * 60 + 55) * 60000);
  await late.enable({ runMinutes: 30 });
  late.advance(6 * 60000);
  expect((await late.request("/control", { runId: late.started[0] })).status).toBe(409);
});

test("account limits and keyset history stay bounded as existing history grows", async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++)
    expect(
      (await f.request("/accounts", { ...account, id: `account_${i}`, handle: `persona_${i}` }))
        .status,
    ).toBe(200);
  expect((await f.request("/accounts", account)).status).toBe(409);
  const history = fixture();
  await history.enable();
  for (let i = 0; i < 60; i++) await history.action(i, { kind: "search", query: `topic ${i}` });
  const latest = await history.snapshot();
  expect(latest.events).toHaveLength(50);
  const older = Schema.decodeUnknownSync(SocialSnapshot)(
    await (await history.request(`?before=${latest.before}`)).json(),
  );
  expect(older.events).toHaveLength(10);
  expect(older.events.some((event) => latest.events.some((recent) => event.id === recent.id))).toBe(
    false,
  );
  expect(
    JSON.stringify(
      history.db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT kind FROM social_event WHERE account_id='first' AND generation=1 AND contact IS NULL ORDER BY id DESC LIMIT 10",
        )
        .all(),
    ),
  ).toContain("social_scope_events");
  expect((await history.request("/accounts", { ...account, personaId: "missing" })).status).toBe(
    400,
  );
});
