import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import type { ContactEntry } from "@ren-ai/onboarding";
import { fixture, request } from "../test/fixtures.ts";
import { createAdmin } from "./admin.ts";
import { managementClient } from "./contact-client.ts";

const waiter: typeof ContactEntry.Type = {
  id: randomUUID(),
  handle: "waiting@example.net",
  createdAt: 1,
  likedPersonas: [
    { id: "luna", name: "루나" },
    { id: "harin", name: "하린" },
    { id: "full", name: "배정 정원 도달" },
  ],
  assignablePersonas: [
    { id: "luna", name: "루나" },
    { id: "harin", name: "하린" },
  ],
  state: "waiting",
  eligible: true,
  reason: "ready",
  persona: null,
  scheduledAt: null,
  requestId: null,
};

test("direct selection offers random or available Likes and preserves exact persona choices through an uncertain request", async () => {
  const f = await fixture();
  const calls: Request[] = [];
  let unavailable = true;
  const admin = createAdmin(f.store, "test-password", "styles", {
    management: managementClient("https://api.test", "test-token", async (input, init) => {
      const call = new Request(input, init);
      calls.push(call.clone());
      if (new URL(call.url).pathname === "/management/discovery")
        return Response.json({ entries: [waiter], eligibleCount: 1 });
      if (unavailable) return new Response(null, { status: 503 });
      return Response.json({ requestId: randomUUID(), requested: 1, entries: [] });
    }),
    log: () => {},
  });
  const page = await (await admin(request("/waitlist"))).text();
  const choices = page.match(/<select[^>]*name="personaID:[^"]+"[^>]*>[\s\S]*?<\/select>/)![0];
  expect(choices).toContain('form="contact-direct-selection"');
  expect(choices).toContain("무작위 배정");
  expect(choices).toContain('<option value="luna">루나</option>');
  expect(choices).toContain('<option value="harin">하린</option>');
  expect(choices).not.toContain("배정 정원 도달");
  expect(page).toContain("무작위 선정");
  expect(page).toContain("현재 배정이 5명 미만");
  expect(page).not.toContain("독점");
  const fields = {
    action: "select-specific",
    requestId: randomUUID(),
    registrationIDs: waiter.id,
    [`personaID:${waiter.id}`]: "harin",
    "personaID:unchecked": "luna",
  };
  const failed = await admin(request("/waitlist", fields));
  expect(failed.status).toBe(503);
  const retry = await failed.text();
  expect(retry).toContain(`name="personaID:${waiter.id}" value="harin"`);
  expect(retry).toContain(`name="requestId" value="${fields.requestId}"`);
  unavailable = false;
  expect((await admin(request("/waitlist", fields))).status).toBe(200);
  const submissions = calls.filter((call) =>
    new URL(call.url).pathname.endsWith("select-assigned"),
  );
  expect(submissions).toHaveLength(2);
  for (const call of submissions)
    expect(await call.json()).toEqual({
      requestId: fields.requestId,
      count: 1,
      registrationIDs: [waiter.id],
      assignments: [{ registrationID: waiter.id, personaID: "harin" }],
    });
});

test("random row choices use normal direct selection, while refused assignment plans never fall back to random", async () => {
  const f = await fixture();
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(new Request(input).url).pathname;
    if (path === "/management/discovery")
      return Response.json({ entries: [waiter], eligibleCount: 1 });
    if (path.endsWith("select-assigned")) return new Response(null, { status: 409 });
    return Response.json({ requestId: randomUUID(), requested: 1, entries: [] });
  });
  const admin = createAdmin(f.store, "test-password", "styles", {
    management: managementClient("https://api.test", "test-token", fetcher),
    log: () => {},
  });
  const fields = {
    action: "select-specific",
    requestId: randomUUID(),
    registrationIDs: waiter.id,
    [`personaID:${waiter.id}`]: "",
  };
  expect((await admin(request("/waitlist", fields))).status).toBe(200);
  expect(fetcher.mock.calls[0]?.[0]).toEqual(
    new URL("https://api.test/management/discovery/select-specific"),
  );
  const refused = await admin(
    request("/waitlist", { ...fields, [`personaID:${waiter.id}`]: "harin" }),
  );
  expect(refused.status).toBe(400);
  const conflict = await refused.text();
  expect(conflict).toContain("배정할 수 없는 Like 후보");
  expect(conflict).toContain("배정 한도 5명");
  expect(conflict).not.toContain("같은 페르소나를 중복 지정");
  expect(fetcher).toHaveBeenCalledTimes(3);
  const form = new FormData();
  form.set("action", "select-specific");
  form.set("requestId", randomUUID());
  form.set("registrationIDs", new Blob(["invalid"]), "registration.txt");
  expect(
    (await admin(new Request(request("/waitlist"), { method: "POST", body: form }))).status,
  ).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
