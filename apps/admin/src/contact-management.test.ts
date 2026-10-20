import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import type { ContactEntry, ContactState } from "@ren-ai/onboarding";
import { createAdmin } from "./admin.ts";
import { managementClient } from "./contact-client.ts";
import type { ManagementClient } from "./contact-client.ts";
import { fixture, request } from "../test/fixtures.ts";
import type { LogEntry } from "./logging.ts";

const entry = (state: typeof ContactState.Type = "waiting"): typeof ContactEntry.Type => ({
  id: randomUUID(),
  handle: "private@example.net",
  createdAt: 100,
  likedPersonas: [{ id: "luna", name: "루나" }],
  state,
  eligible: state === "waiting",
  reason: "ready",
  persona: null,
  scheduledAt: null,
  requestId: null,
});
const idle = {
  start: vi.fn<ManagementClient["start"]>(),
  refreshCatalog: vi.fn<ManagementClient["refreshCatalog"]>(),
  languages: vi.fn<ManagementClient["languages"]>(async () => ({})),
};
const setup = async (client?: ManagementClient) => {
  const f = await fixture();
  const logs: LogEntry[] = [];
  const admin = createAdmin(f.store, "test-password", "styles", {
    ...(client && { management: client }),
    log: (event) => logs.push(event),
  });
  return { admin, logs };
};
const readOnlyContacts = (entries: readonly (typeof ContactEntry.Type)[]) =>
  setup({
    list: async () => ({ entries, eligibleCount: 0 }),
    select: async (input) => ({ ...input, requested: input.count, entries: [] }),
    ...idle,
  });

test("waitlist reads use Workers-supported redirect mode and reject redirects without forwarding credentials", async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.redirect !== "manual") throw new TypeError("Invalid redirect value");
    return Response.json({ entries: [], eligibleCount: 0 });
  });
  const { admin, logs } = await setup(
    managementClient("https://api.test", "secret-token", fetcher),
  );
  expect((await admin(request("/waitlist"))).status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValueOnce(Response.redirect("https://other.test/private", 302));
  const response = await admin(request("/waitlist"));
  expect(response.status).toBe(503);
  expect(response.headers.get("location")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
  const failure = logs.find((event) => event.event === "operation.failed");
  expect(failure?.requestId).toBe(response.headers.get("x-request-id"));
  expect(failure?.code).toBe("management_response");
  expect(failure?.status).toBe(302);
  expect(JSON.stringify(logs)).not.toContain("secret-token");
});

test("authenticated Admin lists, confirms and displays exclusive selection and reservations", async () => {
  const waiting = entry();
  const scheduled = {
    ...entry("scheduled"),
    persona: { id: "luna", name: "루나" },
    scheduledAt: 1234,
    requestId: "server-request",
  };
  const list = vi.fn<ManagementClient["list"]>(async () => ({
    entries: [waiting, scheduled],
    eligibleCount: 1,
  }));
  const select = vi.fn<ManagementClient["select"]>(async (input) => ({
    requestId: input.requestId,
    requested: input.count,
    entries: [scheduled],
  }));
  const { admin } = await setup({ list, select, ...idle });
  expect((await admin(new Request("http://localhost:3729/waitlist"))).status).toBe(401);
  const page = await (await admin(request("/waitlist"))).text();
  expect(page).toContain("대기자 관리");
  expect(page).toContain("private@example.net");
  expect(page).toContain("선정 가능한 대기자");
  const key = /name="requestId" value="([^"]+)"/.exec(page)![1]!;
  expect(page).not.toContain('name="confirm"');
  expect(page).not.toContain("persona.md");
  const submitted = await admin(request("/waitlist", { requestId: key, count: "1" }));
  expect(submitted.status).toBe(200);
  expect(await submitted.text()).toContain("실제 선정 1명");
  expect(select).toHaveBeenCalledWith({ requestId: key, count: 1 });
  const progress = await (await admin(request("/first-contacts"))).text();
  expect(progress).toContain("첫 연락 현황");
  expect(progress).toContain("server-request");
  expect(progress).toContain("결과 확인 필요·실패 건은 자동 재발송하지 않습니다");
});

test("Waitlist shows Notification outcomes without offering resend or changing selection eligibility", async () => {
  const notifications = ["queued", "sent", "failed", "uncertain", "skipped"] as const;
  const { admin } = await readOnlyContacts(
    notifications.map((notification) => ({ ...entry(), notification })),
  );
  const page = await (await admin(request("/waitlist"))).text();
  for (const label of [
    "안내 대기 중",
    "안내 보냄",
    "안내 실패",
    "안내 결과 불확실",
    "안내 생략 (시간당 한도)",
  ])
    expect(page).toContain(label);
  expect(page).not.toContain("resend");
  expect(page.match(/form="contact-direct-selection"/g)).toHaveLength(5);
});

test("Waitlist shows iMessage lookup status and time, and disables unsupported entries", async () => {
  const rows = [
    entry(),
    ...(["available", "unavailable", "failed"] as const).map((status) => ({
      ...entry(),
      eligible: status !== "unavailable",
      reason: status === "unavailable" ? ("no_imessage" as const) : ("ready" as const),
      imessage: { status, checkedAt: 1_000 },
    })),
  ];
  const { admin } = await readOnlyContacts(rows);
  const page = await (await admin(request("/waitlist"))).text();
  for (const label of ["iMessage", "미확인", "사용 가능", "미지원", "확인 실패", "70. 1. 1."])
    expect(page).toContain(label);
  const unsupported = page.split("<tr>").find((row) => row.includes(rows[2]!.id))!;
  expect(unsupported).toContain("disabled");
  expect(unsupported).toContain("iMessage 미지원");
});

test("a waiting test handle starts now with a chosen liked persona", async () => {
  const tester = {
    ...entry(),
    handle: "tester@example.net",
    likedPersonas: [
      { id: "luna", name: "루나" },
      { id: "harin", name: "하린" },
    ],
    testHandle: true,
  };
  const scheduled = {
    ...tester,
    state: "scheduled" as const,
    eligible: false,
    reason: "reserved" as const,
    persona: { id: "harin", name: "하린" },
    scheduledAt: 1234,
    requestId: "server-request",
  };
  const start = vi.fn<ManagementClient["start"]>(async (input) => ({
    requestId: input.requestId,
    requested: 1,
    entries: [scheduled],
  }));
  const { admin } = await setup({
    ...idle,
    list: async () => ({ entries: [entry(), tester], eligibleCount: 2 }),
    select: async (input) => ({ ...input, requested: input.count, entries: [] }),
    start,
    refreshCatalog: idle.refreshCatalog,
    languages: idle.languages,
  });
  const page = await (await admin(request("/waitlist"))).text();
  expect(page).toContain("테스트 연락처 바로 시작");
  expect(page).toContain("테스트 연락처</small>");
  expect(page.match(/name="action" value="start"/g)).toHaveLength(1);
  expect(page).toContain('<option value="harin">하린</option>');
  const key =
    /name="action" value="start"\/><input type="hidden" name="requestId" value="([^"]+)"/.exec(
      page,
    )![1]!;
  const fields = { action: "start", requestId: key, registrationID: tester.id, personaID: "harin" };
  const started = await admin(request("/waitlist", fields));
  expect(started.status).toBe(200);
  expect(await started.text()).toContain("실제 선정 1명");
  expect(start).toHaveBeenCalledWith({
    requestId: key,
    registrationID: tester.id,
    personaID: "harin",
  });
  for (const invalid of [
    { ...fields, personaID: "" },
    { ...fields, registrationID: "private" },
  ])
    expect((await admin(request("/waitlist", invalid))).status).toBe(400);
  expect(start).toHaveBeenCalledTimes(1);
});

test("operators select checked waiters with the same scheduling API and keep exact retry targets", async () => {
  const chosen = entry();
  const reserved = entry("scheduled");
  const select = vi
    .fn<ManagementClient["select"]>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementation(async (input) => ({
      requestId: input.requestId,
      requested: input.count,
      entries: [],
    }));
  const { admin } = await setup({
    list: async () => ({ entries: [chosen, reserved], eligibleCount: 1 }),
    select,
    ...idle,
  });
  const page = await (await admin(request("/waitlist"))).text();
  expect(page).toContain("대기자 직접 선정");
  expect(page).toContain('form="contact-direct-selection"');
  expect(page).toContain(`name="registrationIDs" value="${chosen.id}"`);
  expect(page).toContain(`disabled="" name="registrationIDs" value="${reserved.id}"`);
  const requestId = randomUUID();
  const fields = {
    action: "select-specific",
    requestId,
    registrationIDs: chosen.id,
  };
  const failed = await admin(request("/waitlist", fields));
  expect(failed.status).toBe(503);
  const retry = await failed.text();
  expect(retry).toContain("같은 직접 선정 요청 확인");
  expect(retry).toContain(`name="registrationIDs" value="${chosen.id}"`);
  expect(retry).toContain(`name="requestId" value="${requestId}"`);
  expect((await admin(request("/waitlist", fields))).status).toBe(200);
  expect(select).toHaveBeenLastCalledWith({ requestId, count: 1, registrationIDs: [chosen.id] });
  expect((await admin(request("/waitlist", { ...fields, registrationIDs: "" }))).status).toBe(400);
});

test("direct selections use a separate endpoint so an older API cannot randomly select other waiters", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ requestId: randomUUID(), requested: 1, entries: [] }))
    .mockResolvedValueOnce(Response.json({ entries: [], eligibleCount: 0 }));
  const client = managementClient("https://api.test", "secret-token", fetcher);
  const input = { requestId: randomUUID(), count: 1, registrationIDs: [randomUUID()] };
  const { admin } = await setup(client);
  expect(
    (
      await admin(
        request("/waitlist", {
          action: "select-specific",
          requestId: input.requestId,
          registrationIDs: input.registrationIDs[0]!,
          confirm: "yes",
        }),
      )
    ).status,
  ).toBe(200);
  expect(fetcher.mock.calls[0]?.[0]).toEqual(
    new URL("https://api.test/management/discovery/select-specific"),
  );
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(input));
});

test("a refused or unsupported test start explains the outcome", async () => {
  const input = {
    action: "start",
    requestId: randomUUID(),
    registrationID: randomUUID(),
    personaID: "luna",
    confirm: "yes",
  };
  const refused = await setup(
    managementClient("https://api.test", "secret-token", async (url) =>
      url instanceof URL && url.pathname.endsWith("/start")
        ? Response.json({ error: "start_unavailable" }, { status: 409 })
        : Response.json({ entries: [], eligibleCount: 0 }),
    ),
  );
  const conflict = await refused.admin(request("/waitlist", input));
  expect(conflict.status).toBe(400);
  expect(await conflict.text()).toContain("지금 고른 페르소나로 시작할 수 없습니다");
  const older = await setup(
    managementClient("https://api.test", "secret-token", async () =>
      Response.json({ error: "not_found" }, { status: 404 }),
    ),
  );
  const unsupported = await older.admin(request("/waitlist", input));
  expect(unsupported.status).toBe(503);
  expect(await unsupported.text()).toContain("메시징 API 요청이 실패했습니다");
  const malformed = await setup(
    managementClient("https://api.test", "secret-token", async () =>
      Response.json({ private: "payload" }),
    ),
  );
  expect((await malformed.admin(request("/waitlist", input))).status).toBe(503);
});

test("invalid and cross-origin submissions never select users", async () => {
  const select = vi.fn<ManagementClient["select"]>(async (input) => ({
    requestId: input.requestId,
    requested: input.count,
    entries: [],
  }));
  const { admin } = await setup({
    list: async () => ({ entries: [], eligibleCount: 0 }),
    select,
    ...idle,
  });
  for (const fields of [{ count: "0" }, { count: "1.5" }, { count: "101" }]) {
    expect((await admin(request("/waitlist", { requestId: randomUUID(), ...fields }))).status).toBe(
      400,
    );
  }
  const outside = request("/waitlist", { requestId: randomUUID(), count: "1", confirm: "yes" });
  outside.headers.set("origin", "https://evil.test");
  expect((await admin(outside)).status).toBe(400);
  expect((await admin(request("/first-contacts", { count: "1" }))).status).toBe(400);
  expect(select).not.toHaveBeenCalled();
});

test("network errors retain the confirmation key for safe retries and do not masquerade as empty lists", async () => {
  const input = { requestId: randomUUID(), count: "2", confirm: "yes" };
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("private transport"));
  const { admin, logs } = await setup(
    managementClient("https://api.test", "secret-token", fetcher),
  );
  const response = await admin(request("/waitlist", input));
  expect(response.status).toBe(503);
  const page = await response.text();
  expect(page).toContain(input.requestId);
  expect(page).toContain("같은 선정 요청 확인");
  expect(page).not.toContain("대기 등록이 없습니다");
  expect(page).not.toContain("secret-token");
  expect(response.headers.get("x-request-id")).toBeTruthy();
  expect(logs.filter((event) => event.event === "operation.failed")).toHaveLength(1);
  expect(JSON.stringify(logs)).not.toContain("private transport");
  const unconfigured = await setup();
  expect((await unconfigured.admin(request("/waitlist"))).status).toBe(503);
  const missingToken = await setup(managementClient("https://api.test", ""));
  expect((await missingToken.admin(request("/waitlist"))).status).toBe(503);
});

test("management client narrows configuration, status and JSON failures at the real request boundary", async () => {
  for (const url of [
    "",
    "https://user:password@api.test",
    "http://public.test",
    "ftp://api.test",
  ]) {
    const { admin } = await setup(managementClient(url, "secret-token"));
    expect((await admin(request("/waitlist"))).status).toBe(503);
  }
  for (const response of [
    new Response("private@example.net secret-token", {
      status: 401,
      headers: { "x-request-id": randomUUID() },
    }),
    new Response("unavailable", { status: 503 }),
    new Response("unavailable", {
      status: 503,
      headers: { "x-request-id": "private@example.net" },
    }),
    Response.json({ handle: "private@example.net" }),
    new Response("not-json"),
  ]) {
    const { admin, logs } = await setup(
      managementClient("https://api.test", "secret-token", async () => response),
    );
    expect((await admin(request("/waitlist"))).status).toBe(503);
    expect(JSON.stringify(logs)).not.toContain("private@example.net");
    expect(JSON.stringify(logs)).not.toContain("secret-token");
  }
  const client = managementClient("http://127.0.0.1:4700", "secret-token", async () =>
    Response.json({ entries: [], eligibleCount: 0 }),
  );
  const local = await setup(client);
  expect((await local.admin(request("/waitlist"))).status).toBe(200);
  const badSelection = await setup(
    managementClient("https://api.test", "secret-token", async () =>
      Response.json({ private: "payload" }),
    ),
  );
  expect(
    (
      await badSelection.admin(
        request("/waitlist", { requestId: randomUUID(), count: "1", confirm: "yes" }),
      )
    ).status,
  ).toBe(503);
  const unexpected = await setup({
    list: async () => {
      throw new Error("Unexpected failure");
    },
    select: async (input) => ({ ...input, requested: input.count, entries: [] }),
    ...idle,
  });
  expect((await unexpected.admin(request("/waitlist"))).status).toBe(503);
});

test("empty lists and all first-contact states render without losing status distinctions", async () => {
  const states: (typeof ContactState.Type)[] = [
    "preparing",
    "greeting",
    "active",
    "failed",
    "review",
    "blocked",
    "unreachable",
  ];
  const rows = states.map((state) => ({
    ...entry(state),
    likedPersonas: [],
    reason: "no_persona" as const,
    persona: { id: "missing", name: "missing" },
    requestId: "task-id",
  }));
  const { admin } = await readOnlyContacts(rows);
  const page = await (await admin(request("/first-contacts"))).text();
  for (const label of [
    "대화 준비 중",
    "첫 인사 처리 중",
    "대화 시작",
    "첫 연락 실패",
    "결과 확인 필요",
    "차단·후보 사용 불가",
    "연락처 수정 필요",
    "예정 시각 없음",
  ])
    expect(page).toContain(label);
  const empty = await readOnlyContacts([]);
  expect(await (await empty.admin(request("/waitlist"))).text()).toContain("대기 등록이 없습니다");
  expect(await (await empty.admin(request("/first-contacts"))).text()).toContain(
    "첫 연락 예약이 없습니다",
  );
});

test("ended relationships distinguish delivered and pending notices without exposing current-language actions", async () => {
  const rows = [false, true].map((noticeDelivered) => ({
    ...entry("active"),
    relationshipEnd: { at: 100, noticeDelivered },
  }));
  const { admin } = await readOnlyContacts(rows);
  const page = await (await admin(request("/first-contacts"))).text();
  expect(page).toContain("관계 종료");
  expect(page).toContain("재선택 안내 발송 완료");
  expect(page).toContain("종료 안내 발송 확인 필요");
  expect(page).not.toContain("현재 언어 실력");
});
