import { expect, test, vi } from "vitest";
import { fixture, request } from "../test/fixtures.ts";
import { createAdmin } from "./admin.ts";
import { managementClient } from "./contact-client.ts";
import { socialAccount } from "../../../packages/onboarding/src/social.test-helper.ts";
import { Schema } from "effect";
import { SocialAuthInput } from "@ren-ai/onboarding/social-auth";
import { Window } from "happy-dom";

test.each(["threads", "x"] as const)(
  "%s tab and connection form survive failed API reads without claiming the account list is empty",
  async (platform) => {
    const f = await fixture();
    const fetcher = vi.fn<typeof fetch>();
    const admin = createAdmin(f.store, "test-password", {
      management: managementClient("https://api.test", "secret", fetcher),
      log: () => {},
    });
    for (const failure of ["network", "http", "schema"]) {
      if (failure === "network") fetcher.mockRejectedValueOnce(new Error("offline"));
      else
        fetcher.mockResolvedValueOnce(
          failure === "http"
            ? new Response(null, { status: 503 })
            : Response.json({ invalid: true }),
        );
      const response = await admin(request(`/social?platform=${platform}`));
      expect(response.status).toBe(503);
      const page = await response.text();
      expect(page).toContain(`href="/social?platform=${platform}" aria-current="page"`);
      expect(page).toContain(`${platform === "x" ? "X" : "Threads"} 계정 연결`);
      expect(page).toContain("계정 목록을 불러오지 못했습니다");
      expect(page).toContain("활동 내역을 불러오지 못했습니다");
      expect(page).not.toContain("연결된 계정이 없습니다");
    }
  },
);

test("the selected X tab survives a Persona-store failure before the social API is reached", async () => {
  const f = await fixture();
  f.store.list = async () => {
    throw new Error("store unavailable");
  };
  const response = await createAdmin(f.store, "test-password", { log: () => {} })(
    request("/social?platform=x"),
  );
  expect(response.status).toBe(503);
  expect(await response.text()).toContain('href="/social?platform=x" aria-current="page"');
});

test("operators can check a manually logged-in account without saved credentials or submitting secrets", async () => {
  const f = await fixture();
  const fetcher = vi.fn<typeof fetch>(async (input) =>
    new URL(new Request(input).url).pathname.endsWith("/auth")
      ? Response.json({ state: "authenticated", hasCredentials: false })
      : Response.json({
          accounts: [
            {
              account: socialAccount,
              generation: 1,
              nextAt: null,
              state: "paused",
              turns: 0,
              writes: 0,
            },
          ],
          events: [],
          before: null,
        }),
  );
  const admin = createAdmin(f.store, "test-password", {
    management: managementClient("https://api.test", "secret", fetcher),
    log: () => {},
  });
  const page = await (await admin(request("/social?platform=x&account=first"))).text();
  expect(page).toContain("로그인됨");
  const window = new Window();
  window.document.write(page);
  expect(
    window.document.querySelector('button[value="auth-check"]')!.hasAttribute("disabled"),
  ).toBe(false);
  const response = await admin(
    request("/social?platform=x", { action: "auth-check", id: "first" }),
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/social?platform=x&account=first");
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(SocialAuthInput))(
      fetcher.mock.calls.at(-1)![1]!.body,
    ),
  ).toEqual({ accountId: "first", command: { kind: "check" } });
});
