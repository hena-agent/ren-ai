import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { Schema } from "effect";
import { ContactVisibility } from "@ren-ai/onboarding";
import type { ContactEntry } from "@ren-ai/onboarding";
import { createAdmin } from "./admin.ts";
import { managementClient } from "./contact-client.ts";
import { contactQuery, filterContacts } from "./contact-query.ts";
import { fixture, request } from "../test/fixtures.ts";

const waiter = (fields: Partial<typeof ContactEntry.Type> = {}): typeof ContactEntry.Type => ({
  id: randomUUID(),
  handle: "+821011111111",
  createdAt: 1,
  likedPersonas: [],
  state: "waiting",
  eligible: true,
  reason: "ready",
  persona: null,
  scheduledAt: null,
  requestId: null,
  ...fields,
});
const setup = async (entries: (typeof ContactEntry.Type)[]) => {
  const f = await fixture();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const call = new Request(url, init);
    if (new URL(call.url).pathname.endsWith("/visibility")) {
      const input = Schema.decodeUnknownSync(ContactVisibility)(await call.json());
      entries.forEach((entry, index) => {
        if (input.registrationIDs.includes(entry.id))
          entries[index] = { ...entry, hidden: input.hidden };
      });
      return Response.json(input);
    }
    return Response.json({
      entries,
      eligibleCount: entries.filter((e) => !e.hidden && e.eligible).length,
    });
  });
  return {
    fetcher,
    admin: createAdmin(f.store, "test-password", {
      management: managementClient("https://api.test", "private-token", fetcher),
      log: () => {},
    }),
  };
};

test("URL filters compose, normalize invalid choices, distinguish ended relationships and order deterministically", () => {
  const normal = waiter({ id: "a", handle: "USER@example.net" });
  const testHandle = waiter({ id: "b", testHandle: true, createdAt: 2 });
  const hidden = waiter({ hidden: true, eligible: false });
  const ended = waiter({
    state: "active",
    eligible: false,
    relationshipEnd: { at: 1, noticeDelivered: true },
  });
  const all = [normal, testHandle, hidden, ended];
  const filter = (params: string, first = false) =>
    filterContacts(all, contactQuery(new URLSearchParams(params)), first);
  expect(contactQuery(new URLSearchParams("state=bogus&kind=bogus&sort=bad")).state).toBe("all");
  expect(contactQuery(new URLSearchParams({ search: "x".repeat(200) })).search).toHaveLength(100);
  expect(filter("search=User&kind=normal&eligible=ready&state=waiting")).toEqual([normal]);
  expect(filter("kind=test")).toEqual([testHandle]);
  expect(filter("visibility=hidden&eligible=unavailable")).toEqual([hidden]);
  expect(filter("state=ended")).toEqual([ended]);
  expect(filter("state=active")).toEqual([]);
  expect(filter("kind=normal")).not.toContain(testHandle);
  expect(filter("eligible=ready")).not.toContain(ended);
  expect(filter("visibility=all&sort=oldest")).toEqual(
    [normal, ended, hidden].toSorted((a, b) => a.id.localeCompare(b.id)).concat(testHandle),
  );
  expect(filter("visibility=all")[0]).toBe(testHandle);
  expect(filter("visibility=all", true)).toEqual([ended]);
});

test("Admin hides and restores individual or selected registrations, keeps filters and separates invitations", async () => {
  const visible = waiter();
  const hidden = waiter({ handle: "hidden@example.net", hidden: true, eligible: false });
  const f = await setup([visible, hidden]);
  const initial = await (await f.admin(request("/waitlist"))).text();
  expect(initial).toContain(visible.handle);
  expect(initial).not.toContain(hidden.handle);
  expect(initial).not.toContain("연락처 없이 초대 코드 만들기");
  expect(initial).not.toContain("전화번호로 초대장 지급");
  const response = await f.admin(
    request("/waitlist?kind=normal", { action: "hide", registrationIDs: visible.id }),
  );
  expect(response.status).toBe(200);
  const page = await response.text();
  expect(page).toContain("1개 기록을 숨겼습니다");
  expect(page).toContain('action="/waitlist?kind=normal"');
  expect(page).not.toContain(visible.handle);
  const hiddenPage = await (await f.admin(request("/waitlist?visibility=hidden"))).text();
  expect(hiddenPage).toContain(visible.handle);
  expect(hiddenPage).toContain("선택 복원");
  expect(hiddenPage).toContain("신규 선정 제외");
  expect(
    (await f.admin(request("/first-contacts", { action: "restore", registrationIDs: visible.id })))
      .status,
  ).toBe(200);
  expect(await (await f.admin(request("/waitlist"))).text()).toContain(visible.handle);
  for (const [path, fields] of [
    ["/waitlist", { action: "hide" }],
    ["/waitlist", { action: "restore", registrationIDs: "invalid" }],
    ["/invitations", { action: "hide", registrationIDs: visible.id }],
    ["/waitlist", { action: "invitation-lookup", handle: visible.handle }],
    ["/first-contacts", { action: "start" }],
  ] as const)
    expect((await f.admin(request(path, fields))).status).toBe(400);
  const foreign = request("/waitlist", { action: "hide", registrationIDs: visible.id });
  foreign.headers.set("origin", "https://other.test");
  expect((await f.admin(foreign)).status).toBe(400);
  expect(await (await f.admin(request("/waitlist?search=nomatch"))).text()).toContain(
    "조건에 맞는 기록이 없습니다",
  );
  const codes = await (await f.admin(request("/invitations"))).text();
  expect(codes).toContain("연락처 없이 초대 코드 만들기");
  expect(codes).not.toContain("전화번호로 초대장 지급");
  expect(codes).toContain('href="/invitations" aria-current="page"');
  expect(await (await f.admin(request("/invitations?section=settings"))).text()).toContain(
    "자동 지급 설정을 확인할 수 없습니다",
  );
  f.fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
  expect(
    (await f.admin(request("/waitlist", { action: "hide", registrationIDs: visible.id }))).status,
  ).toBe(503);
});
