import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { createAdmin } from "./admin.ts";
import { managementClient } from "./contact-client.ts";
import { fixture, request } from "../test/fixtures.ts";

test("Admin rechecks a row through the management API, renders persisted safe reasons and keeps origin protection", async () => {
  const f = await fixture();
  const id = randomUUID();
  let failed = false;
  const rechecks: Request[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const upstream = new Request(url, init);
    if (new URL(upstream.url).pathname === "/operator/imessage-recheck") {
      rechecks.push(upstream);
      failed = true;
      return Response.json({});
    }
    return Response.json({
      eligibleCount: 0,
      entries: [
        {
          id,
          handle: "+821072238646",
          createdAt: 1,
          likedPersonas: [],
          state: "waiting",
          eligible: false,
          reason: "imessage_unverified",
          persona: null,
          scheduledAt: null,
          requestId: null,
          imessage: failed
            ? { status: "failed", checkedAt: 2, reason: "iMessage 조회 오류: ids_lookup / 6005" }
            : { status: "unavailable", checkedAt: 1 },
        },
      ],
    });
  });
  const admin = createAdmin(f.store, "test-password", {
    management: managementClient("https://api.test", "secret-token", fetcher),
    log: () => {},
  });
  const initial = await (await admin(request("/waitlist"))).text();
  expect(initial).toContain('value="imessage-recheck"');
  expect(initial).toContain("수신 기기를 찾지 못했습니다");
  const result = await admin(
    request("/waitlist", { action: "imessage-recheck", registrationID: id }),
  );
  expect(result.status).toBe(200);
  const page = await result.text();
  expect(page).toContain("확인 실패");
  expect(page).toContain("ids_lookup / 6005");
  expect(page).toContain("메시지는 발송하지 않았습니다");
  expect(
    (await admin(request("/waitlist", { action: "imessage-recheck", registrationID: "bad" })))
      .status,
  ).toBe(400);
  const foreign = request("/waitlist", { action: "imessage-recheck", registrationID: id });
  foreign.headers.set("Origin", "https://foreign.test");
  expect((await admin(foreign)).status).toBe(400);
  const refreshed = await (await admin(request("/waitlist"))).text();
  expect(refreshed).toContain("ids_lookup / 6005");
  expect(rechecks).toHaveLength(1);
  expect(rechecks[0]?.method).toBe("POST");
  expect(await rechecks[0]!.json()).toEqual({ registrationID: id });
});
