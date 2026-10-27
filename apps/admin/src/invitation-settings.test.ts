import { expect, test, vi } from "vitest";
import { createAdmin } from "./admin.ts";
import { managementClient } from "./contact-client.ts";
import { fixture, request } from "../test/fixtures.ts";
import type { LogEntry } from "./logging.ts";
import { Schema } from "effect";
import { InvitationSettings } from "@ren-ai/onboarding";
import { randomUUID } from "node:crypto";

test("Admin displays and changes persisted invitation issuance with same-origin authentication", async () => {
  const f = await fixture();
  let enabled = false;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (new URL(url instanceof Request ? url.url : url).pathname.endsWith("/invitations")) {
      enabled = Schema.decodeUnknownSync(Schema.fromJsonString(InvitationSettings))(
        init?.body,
      ).enabled;
      return Response.json({ enabled });
    }
    return Response.json({
      entries: [
        {
          id: randomUUID(),
          handle: "+821012345678",
          createdAt: 1,
          likedPersonas: [],
          state: "scheduled",
          eligible: false,
          reason: "reserved",
          persona: null,
          scheduledAt: null,
          requestId: null,
          invitations: [
            { token: "a".repeat(64), redeemedAt: null },
            { token: "b".repeat(64), redeemedAt: 1 },
            { token: "PARTIAL", redeemedAt: 1, usedCount: 1, maxUses: 20, grantCount: 2 },
          ],
        },
      ],
      eligibleCount: 0,
      invitationSettings: { enabled },
    });
  });
  const logs: LogEntry[] = [];
  const admin = createAdmin(f.store, "test-password", {
    management: managementClient("https://api.test", "private-secret", fetcher),
    log: (event) => logs.push(event),
  });
  const get = await admin(request("/waitlist"));
  const page = await get.text();
  expect(page).toContain("초대장 지급 OFF");
  expect(page).toContain(`https://renai.im/explore#invite=${"a".repeat(64)}`);
  expect(page).toContain("초대장 2 · 사용 완료");
  expect(page).toContain("https://renai.im/explore#invite=PARTIAL");
  expect(page).toContain("1/20명 사용 · 선정자에게 2개 지급");
  for (const next of [true, false]) {
    const response = await admin(
      request("/waitlist", { action: "invitations", enabled: String(next) }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`초대장 지급 ${next ? "ON" : "OFF"}`);
    expect(enabled).toBe(next);
  }
  const foreign = request("/waitlist", { action: "invitations", enabled: "true" });
  foreign.headers.set("origin", "https://other.test");
  expect((await admin(foreign)).status).toBe(400);
  expect(enabled).toBe(false);
  expect(
    (await admin(request("/waitlist", { action: "invitations", enabled: "invalid" }))).status,
  ).toBe(400);
  expect(enabled).toBe(false);
  expect(JSON.stringify(logs)).not.toContain("private-secret");
});
