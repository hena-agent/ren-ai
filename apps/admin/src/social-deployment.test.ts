import { expect, test, vi } from "vitest";
import { Window } from "happy-dom";
import type { MacDeploymentStatus } from "@ren-ai/transport/deployment";
import { socialPage } from "./social-page.tsx";
import { socialClient } from "./social-client.ts";
import { fixture, request } from "../test/fixtures.ts";
import { createAdmin } from "./admin.ts";
import { managementClient } from "./contact-client.ts";
import { socialAccount } from "../../../packages/onboarding/src/social.test-helper.ts";
import { loggedRequest } from "./logging.ts";

const status: MacDeploymentStatus = {
  id: "job",
  revision: "development",
  state: "queued",
  stage: "waiting_agent",
  updatedAt: 1,
};
test.each([
  "waiting_agent",
  "queued",
  "installing",
  "starting",
  "verifying",
  "ready",
  "failed",
] as const)("runtime status is visible and protects pending work: %s", (state) => {
  const window = new Window();
  const deployment = {
    ...status,
    state,
    ...(state === "ready" && { gatewayRevision: status.revision, socialRevision: status.revision }),
    ...(state === "failed" && { code: "MAC_COMMAND_FAILED" }),
  };
  window.document.write(
    socialPage({
      personas: [],
      platform: "threads",
      selected: socialAccount,
      snapshot: { accounts: [], events: [], before: null, deployment },
    }),
  );
  const section = window.document.querySelector('section[aria-label="Mac 실행기 관리"]')!;
  expect(section.querySelector("output")!.textContent).not.toBe("");
  const pending = ["queued", "installing", "starting", "verifying"].includes(state);
  expect(section.querySelector("button")!.hasAttribute("disabled")).toBe(pending);
  expect(Boolean(section.querySelector("a"))).toBe(pending);
  expect(section.querySelector("form")!.getAttribute("action")).toBe(
    "/social?platform=threads&account=first",
  );
  expect(section.textContent.includes("MAC_COMMAND_FAILED · 작업 ID: job")).toBe(
    state === "failed",
  );
  expect(section.textContent.includes("게이트웨이: development · 소셜 실행기: development")).toBe(
    state === "ready",
  );
});

test.each([false, true])(
  "operators can request repair without changing saved connection settings (selected: %s)",
  async (selected) => {
    const f = await fixture();
    const submissions: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      const path = new URL(new Request(input).url).pathname;
      if (path.endsWith("/deployment/request")) {
        submissions.push(await new Request(input, options).text());
        return Response.json(status, { status: 202 });
      }
      return Response.json({
        accounts: [
          {
            account: { ...socialAccount, platform: "threads" },
            generation: 1,
            nextAt: null,
            state: "paused",
            turns: 0,
            writes: 0,
          },
        ],
        events: [],
        before: null,
      });
    });
    const admin = createAdmin(f.store, "test-password", {
      management: managementClient("https://api.test", "secret", fetcher),
      log: () => {},
    });
    const response = await admin(
      request("/social?platform=threads", {
        action: "repair-runtime",
        ...(selected && { id: "first" }),
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `/social?platform=threads${selected ? "&account=first" : ""}`,
    );
    expect(submissions).toEqual(["{}"]);
    expect(fetcher.mock.calls.some(([url]) => new Request(url).url.endsWith("/accounts"))).toBe(
      false,
    );
  },
);

test("pending repair can be refreshed before a connection is selected", () => {
  const window = new Window();
  window.document.write(
    socialPage({
      personas: [],
      platform: "x",
      snapshot: { accounts: [], events: [], before: null, deployment: status },
    }),
  );
  const section = window.document.querySelector('section[aria-label="Mac 실행기 관리"]')!;
  expect(section.querySelector("a")!.getAttribute("href")).toBe("/social?platform=x");
  expect(section.querySelector("form")!.getAttribute("action")).toBe("/social?platform=x");
});

test("an invalid repair response is diagnosed without exposing its body", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "private payload" }));
  await loggedRequest(
    request("/social"),
    async () => {
      await expect(
        socialClient("https://api.test", "token", fetcher).repair(),
      ).rejects.toMatchObject({ fields: { code: "social_deployment_schema" } });
      return new Response();
    },
    () => {},
  );
});
