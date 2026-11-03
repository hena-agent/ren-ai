import { afterEach, expect, test, vi } from "vitest";
import { deploymentControl, publicRuntimeReady } from "./deployment-control.ts";
import { ownRuntimeDeployment } from "./deployment-provision.ts";
import type { DeploymentCommand } from "./deployment-command.ts";

afterEach(() => vi.unstubAllGlobals());
const status = {
  id: "job",
  revision: "development",
  state: "queued",
  stage: "waiting_agent",
  updatedAt: 1,
};
test("control calls are authenticated, bounded, redirect-free and schema checked", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ desiredRevision: "development", gatewayUrl: "https://gateway.test", status }),
  );
  const control = deploymentControl("https://api.test", "private-token", fetcher);
  expect((await control.snapshot()).status).toEqual(status);
  fetcher.mockResolvedValueOnce(Response.json(status));
  expect(await control.request()).toEqual(status);
  const lease = { status, lease: "lease" };
  fetcher.mockResolvedValueOnce(Response.json(lease));
  const claimed = await control.claim("agent", "job");
  fetcher.mockResolvedValueOnce(Response.json(status));
  await control.report("agent", claimed, claimed.status);
  expect(fetcher.mock.calls.map(([url]) => new Request(url).url)).toEqual([
    "https://api.test/management/social/deployment",
    "https://api.test/management/social/deployment/request",
    "https://api.test/management/social/deployment/claim",
    "https://api.test/management/social/deployment/report",
  ]);
  for (const [, options] of fetcher.mock.calls) {
    expect(options).toMatchObject({
      redirect: "manual",
      headers: { Authorization: "Bearer private-token" },
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  }
  fetcher.mockResolvedValueOnce(new Response(null, { status: 409 }));
  await expect(control.snapshot()).rejects.toMatchObject({ code: "MAC_CONTROL_CONFLICT" });
  fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(control.snapshot()).rejects.toMatchObject({ code: "MAC_CONTROL_UNAVAILABLE" });
  fetcher.mockResolvedValueOnce(Response.json({ private: "not a snapshot" }));
  await expect(control.snapshot()).rejects.toThrow("Missing key");
});

test.each([
  "https://user:pass@api.test",
  "https://api.test/path",
  "https://api.test?token=x",
  "https://api.test#fragment",
  "http://public.test",
  "ftp://localhost",
])("rejects unsafe control and gateway origins: %s", async (origin) => {
  expect(() => deploymentControl(origin, "token")).toThrow("MAC_CONTROL_ORIGIN_INVALID");
  await expect(publicRuntimeReady(origin, "development")).rejects.toMatchObject({
    code: "MAC_GATEWAY_ORIGIN_INVALID",
  });
});

test.each(["http://localhost:4700", "http://127.0.0.1:4700", "https://gateway.test"])(
  "health requires matching gateway and native executor readiness at %s",
  async (origin) => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    deploymentControl(origin, "token");
    fetcher.mockResolvedValueOnce(
      Response.json({
        service: "api-msg",
        revision: "development",
        status: "ready",
        social: { status: "ready" },
      }),
    );
    expect(await publicRuntimeReady(origin, "development")).toBe(true);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(await publicRuntimeReady(origin, "development", fetcher)).toBe(false);
    fetcher.mockResolvedValueOnce(
      Response.json({
        service: "api-msg",
        revision: "development",
        status: "degraded",
        social: { status: "ready" },
      }),
    );
    expect(await publicRuntimeReady(origin, "development", fetcher)).toBe(false);
    fetcher.mockResolvedValueOnce(
      Response.json({
        service: "api-msg",
        revision: "development",
        status: "ready",
        social: { status: "degraded" },
      }),
    );
    expect(await publicRuntimeReady(origin, "development", fetcher)).toBe(false);
    fetcher.mockRejectedValueOnce(new Error("network failed"));
    expect(await publicRuntimeReady(origin, "development", fetcher)).toBe(false);
  },
);

test("legacy updater takeover waits for an active installer to finish and disables future scheduled runs", async () => {
  const run = vi.fn<DeploymentCommand>().mockRejectedValueOnce(new Error("not registered"));
  await ownRuntimeDeployment(501, run);
  expect(run).toHaveBeenCalledTimes(1);
  run.mockResolvedValue("state = waiting");
  await ownRuntimeDeployment(501, run);
  expect(run).toHaveBeenCalledWith("/bin/launchctl", [
    "disable",
    "gui/501/im.renai.api-msg-deploy",
  ]);
  run.mockResolvedValue("state = running\n pid = 123\n");
  await expect(ownRuntimeDeployment(501, run)).rejects.toMatchObject({
    code: "MAC_LEGACY_UPDATER_BUSY",
  });
  expect(run.mock.calls.some(([, args]) => args.includes("bootout"))).toBe(false);
});
