import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { createAdmin } from "./admin.ts";
import { managementClient } from "./contact-client.ts";
import { fixture, request } from "../test/fixtures.ts";
import type { LogEntry } from "./logging.ts";

test("authenticated operator pages read current Conversation language levels and keep private reasons out of diagnostics", async () => {
  const id = randomUUID();
  const { store } = await fixture();
  const logs: LogEntry[] = [];
  const current = {
    languages: { proficiency: { en: "conversational" }, primary: "ko", native: ["ko"] },
    lastStateChange: { reason: "private learning experience", at: "2026-10-16T12:00:00Z" },
  };
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    new Request(url).url.includes("/operator/languages")
      ? Response.json(current)
      : Response.json({
          entries: [
            {
              id,
              handle: "private@example.org",
              createdAt: 1,
              likedPersonas: [],
              state: "active",
              eligible: false,
              reason: "active",
              persona: null,
              scheduledAt: null,
              requestId: null,
            },
          ],
          eligibleCount: 0,
        }),
  );
  const admin = createAdmin(store, "test-password", {
    management: managementClient("https://api.test", "secret", fetcher),
    log: (event) => logs.push(event),
  });
  expect(
    (await admin(new Request(`http://localhost:3729/first-contacts?languages=${id}`))).status,
  ).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
  const response = await admin(request(`/first-contacts?languages=${id}`));
  expect(response.status).toBe(200);
  const markup = await response.text();
  expect(markup).toContain("현재 대화의 언어 실력");
  expect(markup).toContain("영어 — 일상 대화");
  expect(markup).toContain("private learning experience");
  expect(markup).toContain(`/first-contacts?languages=${id}`);
  expect(fetcher.mock.calls[1]?.[0]).toEqual(
    new URL(`/operator/languages?registrationID=${id}`, "https://api.test"),
  );
  expect(JSON.stringify(logs)).not.toContain("private learning experience");
  expect(JSON.stringify(logs)).not.toContain("private@example.org");
  fetcher.mockImplementation(async (url) =>
    new Request(url).url.includes("/operator/languages")
      ? Response.json({})
      : Response.json({ entries: [], eligibleCount: 0 }),
  );
  expect((await admin(request(`/first-contacts?languages=${id}`))).status).toBe(200);
  fetcher.mockImplementation(async (url) =>
    new Request(url).url.includes("/operator/languages")
      ? Response.json({ languages: { proficiency: { en: "native" } } })
      : Response.json({ entries: [], eligibleCount: 0 }),
  );
  const failed = await admin(request(`/first-contacts?languages=${id}`));
  expect(failed.status).toBe(503);
  expect(logs.findLast((event) => event.code === "management_schema")?.requestId).toBe(
    failed.headers.get("x-request-id"),
  );
});
