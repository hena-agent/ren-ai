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
const setup = async (client?: ManagementClient) => {
  const f = await fixture();
  const logs: LogEntry[] = [];
  const admin = createAdmin(f.store, "test-password", "styles", {
    ...(client && { management: client }),
    log: (event) => logs.push(event),
  });
  return { admin, logs };
};

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
  const { admin } = await setup({ list, select });
  expect((await admin(new Request("http://localhost:3729/waitlist"))).status).toBe(401);
  const page = await (await admin(request("/waitlist"))).text();
  expect(page).toContain("대기자 관리");
  expect(page).toContain("private@example.net");
  expect(page).toContain("선정 가능한 대기자");
  const key = /name="requestId" value="([^"]+)"/.exec(page)![1]!;
  const submitted = await admin(
    request("/waitlist", { requestId: key, count: "1", confirm: "yes" }),
  );
  expect(submitted.status).toBe(200);
  expect(await submitted.text()).toContain("실제 선정 1명");
  expect(select).toHaveBeenCalledWith({ requestId: key, count: 1 });
  const progress = await (await admin(request("/first-contacts"))).text();
  expect(progress).toContain("첫 연락 현황");
  expect(progress).toContain("server-request");
  expect(progress).toContain("결과 확인 필요·실패 건은 자동 재발송하지 않습니다");
});

test("invalid and cross-origin confirmations never select users", async () => {
  const select = vi.fn<ManagementClient["select"]>(async (input) => ({
    requestId: input.requestId,
    requested: input.count,
    entries: [],
  }));
  const { admin } = await setup({ list: async () => ({ entries: [], eligibleCount: 0 }), select });
  for (const fields of [
    { count: "0", confirm: "yes" },
    { count: "1.5", confirm: "yes" },
    { count: "1" },
  ]) {
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
  const { admin } = await setup({
    list: async () => ({ entries: rows, eligibleCount: 0 }),
    select: async (input) => ({ ...input, requested: input.count, entries: [] }),
  });
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
  const empty = await setup({
    list: async () => ({ entries: [], eligibleCount: 0 }),
    select: async (input) => ({ ...input, requested: input.count, entries: [] }),
  });
  expect(await (await empty.admin(request("/waitlist"))).text()).toContain("대기 등록이 없습니다");
  expect(await (await empty.admin(request("/first-contacts"))).text()).toContain(
    "첫 연락 예약이 없습니다",
  );
});
