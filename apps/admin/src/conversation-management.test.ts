import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import type { ConversationEntry } from "@ren-ai/onboarding";
import { fixture, request } from "../test/fixtures.ts";
import { createAdmin } from "./admin.ts";
import { managementClient, type ConversationClient } from "./contact-client.ts";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ManagementClient } from "./contact-client.ts";
import { loggedRequest } from "./logging.ts";
import { PersonaError } from "@ren-ai/personas";

const entry: typeof ConversationEntry.Type = {
  id: 1,
  handle: "alma@example.com",
  personaID: "seoyul",
  personaName: "강서율",
  sessionID: "ses_seoyul",
  startedAt: 100,
  endedAt: null,
  stoppedAt: null,
  canNotify: false,
  lastReceivedAt: 200,
  lastSentAt: 210,
  farewell: "cancelled",
  notice: "cancelled",
};
const detail = {
  entry,
  history: [entry],
  registrations: [
    {
      id: randomUUID(),
      createdAt: 10,
      archivedAt: null,
      personaID: "seoyul",
      state: "active",
      selectionID: randomUUID(),
    },
  ],
};

test("Admin lists bindings, searches, pages and opens real runtime status with relationship and registration histories", async () => {
  const f = await fixture();
  const registrationNextBefore = randomUUID();
  const client: ConversationClient = {
    list: vi.fn<ConversationClient["list"]>(async () => ({ entries: [entry], nextBefore: 1 })),
    detail: vi.fn<ConversationClient["detail"]>(async () => ({
      ...detail,
      registrationNextBefore,
    })),
    runtime: vi.fn<ConversationClient["runtime"]>(async () => ({
      state: "running" as const,
      pending: 2,
      nextWakeAt: 500,
    })),
    recover: vi.fn<ConversationClient["recover"]>(async () => {}),
  };
  const admin = createAdmin(f.store, "test-password", "styles", {
    management: fromPartial<ManagementClient>({ conversations: client }),
  });
  expect((await admin(new Request("http://localhost:3729/conversations"))).status).toBe(401);
  expect(client.list).not.toHaveBeenCalled();
  const page = await (
    await admin(request("/conversations?filter=all&search=ses_&before=5"))
  ).text();
  expect(client.list).toHaveBeenCalledWith({ filter: "all", search: "ses_", before: 5 });
  for (const text of [
    "대화 상태",
    "alma@example.com",
    "강서율",
    "ses_seoyul",
    "Conversation #1",
    "다음 25개",
  ])
    expect(page).toContain(text);
  const active = await (await admin(request("/conversations/1"))).text();
  expect(active).toContain("실행 중");
  expect(active).toContain("대기 작업 2개");
  expect(active).toContain("현재 언어 실력 보기");
  expect(active).toContain("이전 등록 25개");
  await admin(request(`/conversations/1?registrationsBefore=${registrationNextBefore}`));
  expect(client.detail).toHaveBeenLastCalledWith(1, registrationNextBefore);
  expect((await admin(request("/conversations/1?registrationsBefore=invalid"))).status).toBe(400);
  expect(active).not.toContain('value="stop"');
  const ended = {
    ...entry,
    endedAt: 300,
    stoppedAt: 310,
    farewell: "failed" as const,
    notice: "uncertain" as const,
    canNotify: true,
  };
  client.detail = async () => ({
    entry: ended,
    history: [ended],
    registrations: [{ ...detail.registrations[0]!, archivedAt: 300 }],
  });
  const stopped = await (await admin(request("/conversations/1?queued=1"))).text();
  expect(stopped).toContain("정지 확인");
  expect(stopped).toContain("확정 실패");
  expect(stopped).toContain("결과 불확실");
  expect(stopped).toContain("이전 등록");
  expect(stopped).toContain("복구 작업을 접수");
  expect(stopped).toMatch(/<button[^>]*value="notice"[^>]*disabled/);
  const key = /name="requestId" value="([^"]+)"/.exec(stopped)![1]!;
  const response = await admin(request("/conversations/1", { action: "stop", requestId: key }));
  expect(response.status).toBe(303);
  expect(client.recover).toHaveBeenCalledWith({ id: 1, action: "stop", requestId: key });
  client.detail = async () => ({
    entry: { ...ended, farewell: "sent", notice: "sent" },
    history: [],
    registrations: [],
  });
  const delivered = await (await admin(request("/conversations/1"))).text();
  expect(delivered).toMatch(/<button(?=[^>]*value="notice")(?![^>]*disabled)[^>]*>/);
  client.detail = async () => ({
    entry: { ...ended, stoppedAt: null, canNotify: false },
    history: [],
    registrations: [
      {
        id: randomUUID(),
        createdAt: 1,
        archivedAt: null,
        personaID: null,
        state: null,
        selectionID: null,
      },
    ],
  });
  const pending = await (await admin(request("/conversations/1"))).text();
  expect(pending).toContain("정지 미확인");
  expect(pending).toContain("미배정");
  client.list = async () => ({ entries: [], nextBefore: null });
  expect(await (await admin(request("/conversations"))).text()).toContain(
    "조건에 맞는 대화가 없습니다.",
  );
  client.runtime = async () => {
    throw new Error("executor offline");
  };
  const unavailable = await (await admin(request("/conversations/1"))).text();
  expect(unavailable).toContain("조회 실패 — 정지 여부 미확인");
  expect(unavailable).toContain("ses_seoyul");
  expect((await admin(request("/conversations?filter=bad"))).status).toBe(400);
  expect((await admin(request("/conversations/not-found"))).status).toBe(404);
  expect(
    (await admin(request("/conversations/1", { action: "invalid", requestId: key }))).status,
  ).toBe(400);
  const cross = request("/conversations/1", { action: "stop", requestId: key });
  cross.headers.set("origin", "https://evil.test");
  expect((await admin(cross)).status).toBe(400);
  expect((await admin(request("/conversations", { action: "stop", requestId: key }))).status).toBe(
    400,
  );
  client.detail = async () => {
    throw new Error("database unavailable");
  };
  expect((await admin(request("/conversations/1"))).status).toBe(503);
  client.detail = async () => {
    throw new PersonaError("not_found", "대화를 찾을 수 없습니다.");
  };
  expect((await admin(request("/conversations/999"))).status).toBe(404);
  client.recover = async () => {
    throw new PersonaError("conflict", "상태를 다시 확인해 주세요.");
  };
  expect(
    (await admin(request("/conversations/1", { action: "stop", requestId: key }))).status,
  ).toBe(409);
  const unconfigured = createAdmin(f.store, "test-password", "styles");
  expect((await unconfigured(request("/conversations"))).status).toBe(503);
});

test("conversation client authenticates and validates every response without leaking upstream payloads", async () => {
  await loggedRequest(
    request("/conversations"),
    async () => {
      const calls: Request[] = [];
      let invalid = false;
      let status = 200;
      const management = managementClient(
        "https://api.test",
        "private-token",
        async (input, init) => {
          const incoming = new Request(input, init);
          calls.push(incoming);
          if (status !== 200) return new Response(null, { status });
          if (invalid) return Response.json({ secret: "private payload" });
          const url = new URL(incoming.url);
          if (url.pathname === "/management/conversations")
            return Response.json({ entries: [entry], nextBefore: null });
          if (url.pathname.startsWith("/management/conversations/")) return Response.json(detail);
          return Response.json({ state: "idle", pending: 0, nextWakeAt: null });
        },
      );
      const client = management.conversations!;
      await management.refreshCatalog();
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.url).toBe("https://api.test/management/catalog/refresh");
      expect((await client.list({ filter: "active", search: "alma" })).entries[0]?.sessionID).toBe(
        "ses_seoyul",
      );
      await client.list({ filter: "all", search: "", before: 2 });
      expect(calls.some((call) => new URL(call.url).searchParams.get("before") === "2")).toBe(true);
      expect((await client.detail(1)).entry.personaName).toBe("강서율");
      await client.detail(1, randomUUID());
      expect((await client.runtime(1)).state).toBe("idle");
      await client.recover({ id: 1, action: "notice", requestId: randomUUID() });
      expect(
        calls.every((call) => call.headers.get("authorization") === "Bearer private-token"),
      ).toBe(true);
      expect(calls.at(-1)?.method).toBe("POST");
      invalid = true;
      await expect(client.detail(1)).rejects.toThrow("대화 상태 응답 형식");
      status = 409;
      await expect(
        client.recover({ id: 1, action: "notice", requestId: randomUUID() }),
      ).rejects.toThrow("종료·전송 상태");
      status = 404;
      await expect(client.detail(1)).rejects.toThrow("대화를 찾을 수 없습니다");
      await expect(client.runtime(1)).rejects.toThrow("메시징 API 요청이 실패");
      return new Response(null);
    },
    () => {},
  );
});
