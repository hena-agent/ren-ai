import { expect, test, vi } from "vitest";
import { SocialAccount, type SocialSnapshot } from "@ren-ai/onboarding/social";
import { Schema } from "effect";
import { socialAccount } from "../../../packages/onboarding/src/social.test-helper.ts";
import { fixture, request, legacy, initialDocuments } from "../test/fixtures.ts";
import { createAdmin } from "./admin.ts";
import { managementClient } from "./contact-client.ts";
import { socialClient } from "./social-client.ts";
import { socialPage } from "./social-page.tsx";
import { loggedRequest, type LogEntry } from "./logging.ts";
import { SocialAuthInput, type SocialAuthStatus } from "@ren-ai/onboarding/social-auth";

const initial = (): SocialSnapshot => ({ accounts: [], events: [], before: null });
async function setup() {
  const f = await fixture();
  await f.store.save({ ...legacy, id: "alice", name: "앨리스" }, initialDocuments, { persona: "" });
  await f.store.save({ ...legacy, id: "bob", name: "보라" }, initialDocuments, { persona: "" });
  let snapshot = initial();
  let authentication: SocialAuthStatus = { state: "not_configured", hasCredentials: false };
  const submissions: { path: string; body: string }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const incoming = new Request(input, init);
    const path = new URL(incoming.url).pathname;
    const body = init?.method === "POST" ? await incoming.text() : "";
    if (init?.method === "POST") submissions.push({ path, body });
    if (path.endsWith("/auth")) {
      const authInput = Schema.decodeUnknownSync(Schema.fromJsonString(SocialAuthInput))(body);
      if (authInput.command.kind === "save")
        authentication = { state: "logging_in", hasCredentials: true };
      if (authInput.command.kind === "code")
        authentication = { state: "authenticated", hasCredentials: true };
      if (authInput.command.kind === "forget")
        authentication = { state: "not_configured", hasCredentials: false };
      return Response.json(authentication);
    }
    if (path.endsWith("/accounts")) {
      const saved = Schema.decodeUnknownSync(Schema.fromJsonString(SocialAccount))(body);
      snapshot = {
        ...snapshot,
        accounts: [
          { account: saved, generation: 1, nextAt: null, state: "paused", turns: 0, writes: 0 },
        ],
      };
    }
    return path.endsWith("/open") || path.endsWith("/now")
      ? new Response(null, { status: 204 })
      : Response.json(snapshot);
  });
  const logs: LogEntry[] = [];
  const admin = createAdmin(f.store, "test-password", {
    management: managementClient("https://api.test", "secret", fetcher),
    log: (event) => logs.push(event),
  });
  const fields = {
    ...Object.fromEntries(
      Object.entries(socialAccount).map(([key, value]) => [key, String(value)]),
    ),
    action: "save",
    username: "PRIVATE_ID@example.test",
    password: "PRIVATE_PASSWORD",
    enabled: "1",
    id: "",
  };
  return {
    ...f,
    admin,
    logs,
    fetcher,
    fields,
    submissions,
    setAuthentication: (value: SocialAuthStatus) => {
      authentication = value;
    },
  };
}

test("Admin selects which Persona owns an X account, then can edit, pause, open Canary and schedule it", async () => {
  const f = await setup();
  const response = await f.admin(request("/social?persona=bob"));
  expect(response.status).toBe(200);
  const page = await response.text();
  expect(page).toContain('href="/social" aria-current="page"');
  expect(page).toContain('<option value="bob" selected="">보라 · bob</option>');
  expect(page).toContain("연결된 계정이 없습니다");
  expect(page).toContain('name="username"');
  expect(page).toContain('name="password"');
  expect(page).toContain("연결하고 로그인");
  expect((await f.admin(request("/social?before=50"))).status).toBe(200);
  expect((await f.admin(request("/social", { ...f.fields, personaId: "bob" }))).status).toBe(303);
  expect(f.submissions[0]).toMatchObject({ path: "/management/social/accounts" });
  expect(JSON.parse(f.submissions[0]!.body)).toMatchObject({
    id: "x_persona_x",
    personaId: "bob",
    enabled: true,
  });
  const selected = await (await f.admin(request("/social?account=x_persona_x"))).text();
  expect(selected).toContain("@persona_x 연결 설정");
  for (const action of ["open", "now", "toggle"])
    expect((await f.admin(request("/social", { id: "x_persona_x", action }))).status).toBe(303);
  expect(JSON.parse(f.submissions.at(-1)!.body)).toMatchObject({
    personaId: "bob",
    enabled: false,
  });
  expect(
    (
      await f.admin(
        request("/social", {
          ...f.fields,
          id: "x_persona_x",
          personaId: "alice",
          username: "",
          password: "",
        }),
      )
    ).status,
  ).toBe(303);
  expect(JSON.parse(f.submissions.at(-1)!.body)).toMatchObject({
    id: "x_persona_x",
    personaId: "alice",
  });
  expect(await (await f.admin(request("/personas/alice"))).text()).toContain(
    "/social?persona=alice",
  );
});

test("operators submit ID/password and verification codes without credentials returning in HTML or logs", async () => {
  const f = await setup();
  const login = {
    ...f.fields,
  };
  const response = await f.admin(request("/social", login));
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/social?account=x_persona_x");
  const submission = Schema.decodeUnknownSync(Schema.fromJsonString(SocialAuthInput))(
    f.submissions.at(-1)!.body,
  );
  expect(submission).toEqual({
    accountId: "x_persona_x",
    command: { kind: "save", username: login.username, password: login.password },
  });
  expect(f.submissions.map((row) => row.path)).toEqual([
    "/management/social/accounts",
    "/management/social/auth",
  ]);
  expect(f.submissions[0]!.body).not.toContain("PRIVATE");
  expect((await f.admin(request("/social", { ...login, id: "x_persona_x" }))).status).toBe(303);
  expect(f.submissions.at(-1)?.path).toBe("/management/social/auth");
  const pending = await (await f.admin(request("/social?account=x_persona_x"))).text();
  expect(pending).toContain("로그인 진행 중");
  expect(pending).toContain("<fieldset disabled");
  expect(pending).not.toContain(login.username);
  expect(pending).not.toContain(login.password);
  f.setAuthentication({ state: "code_required", hasCredentials: true });
  expect(await (await f.admin(request("/social?account=x_persona_x"))).text()).toContain(
    'name="code"',
  );
  expect(
    (await f.admin(request("/social", { action: "auth-code", id: "x_persona_x", code: "123456" })))
      .status,
  ).toBe(303);
  expect(
    (await f.admin(request("/social", { action: "auth-login", id: "x_persona_x" }))).status,
  ).toBe(303);
  expect(
    (await f.admin(request("/social", { action: "auth-forget", id: "x_persona_x" }))).status,
  ).toBe(303);
  expect(await (await f.admin(request("/social?account=x_persona_x"))).text()).toContain(
    "로그인 정보 없음",
  );
  expect(logsContainPrivate(f.logs)).toBe(false);
});

function logsContainPrivate(logs: readonly LogEntry[]) {
  return /PRIVATE_ID|PRIVATE_PASSWORD|123456/.test(JSON.stringify(logs));
}

test("new connections validate both login fields before saving anything", async () => {
  const f = await setup();
  for (const missing of [{ username: "" }, { password: "" }, { username: "", password: "" }]) {
    const response = await f.admin(request("/social", { ...f.fields, ...missing }));
    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).not.toContain(f.fields.password);
    expect(page).not.toContain(f.fields.username);
  }
  expect(f.submissions).toEqual([]);
  expect(logsContainPrivate(f.logs)).toBe(false);
});

test("connection and login failures identify the failed step, keep saved settings and never replay credentials into HTML", async () => {
  const f = await setup();
  const ordinary = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (input, init) => {
    if (new URL(new Request(input, init).url).pathname.endsWith("/accounts"))
      return new Response(null, { status: 503 });
    return ordinary(input, init);
  });
  const configurationFailure = await f.admin(request("/social", f.fields));
  expect(configurationFailure.status).toBe(503);
  expect(await configurationFailure.text()).not.toContain("계정 연결은 저장됐지만");
  expect(f.submissions).toEqual([]);
  f.fetcher.mockImplementation(async (input, init) => {
    if (new URL(new Request(input, init).url).pathname.endsWith("/auth"))
      throw new Error(`${f.fields.username} ${f.fields.password}`);
    return ordinary(input, init);
  });
  const loginFailure = await f.admin(request("/social", f.fields));
  expect(loginFailure.status).toBe(503);
  const page = await loginFailure.text();
  expect(page).toContain("계정 연결은 저장됐지만 로그인 요청을 시작하지 못했습니다");
  expect(page).toContain("@persona_x 연결 설정");
  expect(page).toContain('value="x_persona_x"');
  expect(page).not.toContain(f.fields.username);
  expect(page).not.toContain(f.fields.password);
  expect(f.submissions).toHaveLength(1);
  expect(f.submissions[0]!.body).not.toContain("PRIVATE");
  expect(logsContainPrivate(f.logs)).toBe(false);
  f.fetcher.mockImplementation(ordinary);
  expect((await f.admin(request("/social", { ...f.fields, id: "x_persona_x" }))).status).toBe(303);
  expect(f.submissions.at(-1)?.path).toBe("/management/social/auth");
});

test("login forms retain no submitted secrets on errors and expose actionable authentication states", async () => {
  const f = await setup();
  await f.admin(request("/social", f.fields));
  for (const state of [
    { state: "failed", hasCredentials: true, reason: "account_mismatch" },
    { state: "failed", hasCredentials: true, reason: "credentials_rejected" },
    { state: "manual_required", hasCredentials: true },
  ] as const) {
    f.setAuthentication(state);
    expect(await (await f.admin(request("/social?account=x_persona_x"))).text()).toContain(
      'role="alert"',
    );
  }
  expect(
    (
      await f.admin(
        request("/social", {
          action: "auth-code",
          id: "missing",
          username: "PRIVATE_ID",
          password: "PRIVATE_PASSWORD",
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await f.admin(request("/social", { ...f.fields, id: "x_persona_x", password: "" }))).status,
  ).toBe(400);
  const ordinary = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (input, init) => {
    if (new URL(new Request(input, init).url).pathname.endsWith("/auth"))
      throw new Error("PRIVATE_PASSWORD echoed upstream");
    return ordinary(input, init);
  });
  const failed = await f.admin(
    request("/social", { action: "auth-code", id: "x_persona_x", code: "123456" }),
  );
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("123456");
  expect(logsContainPrivate(f.logs)).toBe(false);
  const unavailable = await f.admin(request("/social?account=x_persona_x"));
  expect(unavailable.status).toBe(200);
  expect(await unavailable.text()).toContain("로그인 상태를 확인할 수 없습니다");
});

test("social forms retain the workspace on failure and reject foreign origins, bad fields and unknown actions", async () => {
  const f = await setup();
  const foreign = request("/social", f.fields);
  foreign.headers.set("origin", "https://evil.test");
  expect((await f.admin(foreign)).status).toBe(400);
  expect((await f.admin(request("/social", { action: "save", handle: "" }))).status).toBe(400);
  expect((await f.admin(request("/social", { action: "save" }))).status).toBe(400);
  expect((await f.admin(request("/social", { action: "unknown", id: "missing" }))).status).toBe(
    400,
  );
  await f.admin(request("/social", f.fields));
  expect((await f.admin(request("/social", { action: "unknown", id: "x_persona_x" }))).status).toBe(
    400,
  );
  f.fetcher.mockRejectedValue(new Error("secret private prompt"));
  const failed = await f.admin(request("/social"));
  expect(failed.status).toBe(503);
  expect(await failed.text()).toContain("소셜 활동");
  expect(JSON.stringify(f.logs)).not.toContain("secret");
  const unconfigured = createAdmin(f.store, "test-password", {
    log: (event) => f.logs.push(event),
  });
  expect((await unconfigured(request("/social"))).status).toBe(400);
});

test("social history shows account bindings, uncertainty, result links and pagination without exposing private Persona descriptions", () => {
  const snapshot: SocialSnapshot = {
    accounts: [
      {
        account: socialAccount,
        generation: 1,
        nextAt: 1000,
        state: "custom-state",
        turns: 2,
        writes: 1,
      },
    ],
    events: [
      {
        id: 51,
        runId: "run",
        accountId: "first",
        personaId: "alice",
        at: 1000,
        kind: "future-kind",
        state: "pending",
        reason: "Another action",
        text: "",
        url: null,
      },
      {
        id: 50,
        runId: "run",
        accountId: "first",
        personaId: "alice",
        at: 1000,
        kind: "reply",
        state: "uncertain",
        reason: "Relevant interest",
        text: "A reply",
        url: "https://x.com/reader/status/123",
      },
    ],
    before: 50,
  };
  const page = socialPage({
    personas: [],
    snapshot,
    selected: socialAccount,
    error: "Example error",
  });
  expect(page).toContain("결과 미확인");
  expect(page).toContain("/social?before=50");
  expect(page).toContain("https://x.com/reader/status/123");
  expect(page).toContain("custom-state");
  expect(page).toContain("future-kind");
  expect(page).toContain("다음 확인");
  expect(page).toContain('role="alert"');
});

test("social API transport validates origins and response schemas and handles conflicts without leaking input", async () => {
  await loggedRequest(
    request("/social"),
    async () => {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json(initial()));
      await expect(socialClient("", "", fetcher).list()).rejects.toThrow("연결 설정");
      await expect(
        socialClient("https://user:secret@app.test", "secret", fetcher).list(),
      ).rejects.toThrow("주소");
      await expect(socialClient("http://app.test", "secret", fetcher).list()).rejects.toThrow(
        "주소",
      );
      const client = socialClient("http://localhost:4879", "secret", fetcher);
      await client.list(50);
      expect(new Request(fetcher.mock.calls.at(-1)![0]).url).toContain("before=50");
      expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ redirect: "manual" });
      fetcher.mockResolvedValueOnce(new Response(null, { status: 409 }));
      await expect(client.configure(socialAccount)).rejects.toThrow("새로고침");
      fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
      await expect(client.operate("open", "first")).rejects.toThrow("실패");
      fetcher.mockResolvedValueOnce(Response.json({ private: "input" }));
      await expect(client.list()).rejects.toThrow("형식");
      fetcher.mockResolvedValueOnce(Response.json({ private: "PRIVATE_AUTH_RESPONSE" }));
      await expect(client.authenticate("first", { kind: "status" })).rejects.toThrow(
        "로그인 상태 응답 형식",
      );
      return new Response(null);
    },
    () => {},
  );
});
