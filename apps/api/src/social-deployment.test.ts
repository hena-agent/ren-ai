import { expect, test } from "vitest";
import { Schema } from "effect";
import {
  DeploymentLease,
  DeploymentSnapshot,
  MacDeploymentStatus,
} from "@ren-ai/transport/deployment";
import { socialTestContext } from "../test/social.test-helper.ts";
import { createSocial } from "./social/http.ts";

const context = socialTestContext();
test("repair jobs persist across actor replacement, coalesce requests and fence leases", async () => {
  const f = context.fixture();
  const initial = Schema.decodeUnknownSync(DeploymentSnapshot)(
    await (await f.request("/deployment")).json(),
  );
  expect(initial).toMatchObject({
    gatewayUrl: "https://api-msg.renai.im",
    status: { state: "waiting_agent", updatedAt: 0 },
  });
  const requested = await f.request("/deployment/request", {});
  expect(requested.status).toBe(202);
  const job = Schema.decodeUnknownSync(MacDeploymentStatus)(await requested.json());
  expect(job.state).toBe("queued");
  expect(await (await f.request("/deployment/request", {})).json()).toEqual(job);
  const claim = (agentId: string, operationId = job.id) =>
    f.request("/deployment/claim", { agentId, operationId });
  expect((await claim("one", "missing")).status).toBe(409);
  const first = Schema.decodeUnknownSync(DeploymentLease)(await (await claim("one")).json());
  expect(await (await claim("one")).json()).toEqual(first);
  expect((await claim("two")).status).toBe(409);
  const replacement = createSocial(f.storage, { ...f.options, gatewayUrl: "https://gateway.test" });
  const snap = Schema.decodeUnknownSync(DeploymentSnapshot)(
    await (
      await replacement.fetch(
        new Request("https://api.test/management/social/deployment", {
          headers: { Authorization: "Bearer secret" },
        }),
      )
    ).json(),
  );
  expect(snap.status).toEqual(job);
  expect(snap.gatewayUrl).toBe("https://gateway.test");
  const report = (
    overrides: {
      agentId?: string;
      operationId?: string;
      lease?: string;
      status?: MacDeploymentStatus;
    } = {},
  ) =>
    f.request("/deployment/report", {
      agentId: "one",
      operationId: job.id,
      lease: first.lease,
      status: { ...job, state: "installing", stage: "artifact", updatedAt: 1 },
      ...overrides,
    });
  for (const input of [
    { agentId: "two" },
    { lease: "wrong" },
    { operationId: "wrong" },
    { status: { ...job, id: "wrong" } },
    { status: { ...job, revision: "a".repeat(40) } },
  ])
    expect((await report(input)).status).toBe(409);
  expect((await report()).status).toBe(200);
  expect((await f.snapshot()).deployment).toMatchObject({
    state: "installing",
    updatedAt: f.options.now(),
  });
  f.advance(1200000);
  expect((await report()).status).toBe(409);
  const second = Schema.decodeUnknownSync(DeploymentLease)(await (await claim("two")).json());
  expect(second.lease).not.toBe(first.lease);
  expect((await report()).status).toBe(409);
  expect(
    (
      await report({
        agentId: "two",
        lease: second.lease,
        status: { ...job, state: "ready", stage: "complete" },
      })
    ).status,
  ).toBe(200);
  expect((await claim("two")).status).toBe(409);
  const next = Schema.decodeUnknownSync(MacDeploymentStatus)(
    await (await f.request("/deployment/request", {})).json(),
  );
  expect(next.id).not.toBe(job.id);
  expect((await report()).status).toBe(409);
});

test("deployment controls reject invalid input and missing operations before accepting reports", async () => {
  const f = context.fixture();
  expect(
    (await f.request("/deployment/claim", { agentId: "one", operationId: "missing" })).status,
  ).toBe(409);
  const status: MacDeploymentStatus = {
    id: "none",
    revision: "development",
    state: "failed",
    stage: "repair",
    updatedAt: 1,
  };
  expect(
    (
      await f.request("/deployment/report", {
        agentId: "one",
        operationId: "none",
        lease: "none",
        status,
      })
    ).status,
  ).toBe(409);
  expect(
    (await f.request("/deployment/claim", { agentId: "private prompt", operationId: "none" }))
      .status,
  ).toBe(400);
  expect(
    (
      await f.request("/deployment/report", {
        agentId: "one",
        operationId: "none",
        lease: "none",
        status: { ...status, code: "private data" },
      })
    ).status,
  ).toBe(400);
  expect(JSON.stringify(context.logs)).not.toContain("private prompt");
});
