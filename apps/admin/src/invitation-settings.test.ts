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
  const get = await admin(request("/invitations?section=settings"));
  const page = await get.text();
  expect(page).toContain("초대장 자동 지급");
  expect(page).toContain(">OFF</span>");
  const waitlist = await (await admin(request("/waitlist"))).text();
  expect(waitlist).toContain("/invitations?section=phone");
  expect(waitlist).not.toContain(`https://renai.im/explore#invite=${"a".repeat(64)}`);
  expect(waitlist).not.toContain("초대장 지급 설정");
  for (const next of [true, false]) {
    const response = await admin(
      request("/invitations?section=settings", { action: "invitations", enabled: String(next) }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`>${next ? "ON" : "OFF"}</span>`);
    expect(enabled).toBe(next);
  }
  const foreign = request("/invitations?section=settings", {
    action: "invitations",
    enabled: "true",
  });
  foreign.headers.set("origin", "https://other.test");
  expect((await admin(foreign)).status).toBe(400);
  expect(enabled).toBe(false);
  expect(
    (
      await admin(
        request("/invitations?section=settings", { action: "invitations", enabled: "invalid" }),
      )
    ).status,
  ).toBe(400);
  expect(enabled).toBe(false);
  expect(JSON.stringify(logs)).not.toContain("private-secret");
});
