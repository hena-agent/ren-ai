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

const initial = (): SocialSnapshot => ({ accounts: [], events: [], before: null });
async function setup() {
  const f = await fixture();
  await f.store.save({ ...legacy, id: "alice", name: "앨리스" }, initialDocuments, { persona: "" });
  await f.store.save({ ...legacy, id: "bob", name: "보라" }, initialDocuments, { persona: "" });
  let snapshot = initial();
  const submissions: { path: string; body: string }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const incoming = new Request(input, init);
    const path = new URL(incoming.url).pathname;
    const body = init?.method === "POST" ? await incoming.text() : "";
    if (init?.method === "POST") submissions.push({ path, body });
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
    enabled: "1",
    id: "",
  };
  return { ...f, admin, logs, fetcher, fields, submissions };
}

test("Admin selects which Persona owns an X account, then can edit, pause, open Canary and schedule it", async () => {
  const f = await setup();
  const response = await f.admin(request("/social?persona=bob"));
  expect(response.status).toBe(200);
  const page = await response.text();
  expect(page).toContain('href="/social" aria-current="page"');
  expect(page).toContain('<option value="bob" selected="">보라 · bob</option>');
  expect(page).toContain("연결된 계정이 없습니다");
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
    (await f.admin(request("/social", { ...f.fields, id: "x_persona_x", personaId: "alice" })))
      .status,
  ).toBe(303);
  expect(JSON.parse(f.submissions.at(-1)!.body)).toMatchObject({
    id: "x_persona_x",
    personaId: "alice",
  });
  expect(await (await f.admin(request("/personas/alice"))).text()).toContain(
    "/social?persona=alice",
  );
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
      return new Response(null);
    },
    () => {},
  );
});
