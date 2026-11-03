import { chmod, mkdir, readFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { MacDeploymentStatus } from "@ren-ai/transport/deployment";
import { runDeploymentAgent, type AgentOptions } from "./deployment-agent.ts";
import { atomicFile, exists } from "./deployment-files.ts";
import { DeploymentFailure } from "./deployment-command.ts";
import { deploymentTestContext } from "./deployment.test-helper.ts";

const temporary = deploymentTestContext();
const revision = "a".repeat(40);
async function fixture(state: MacDeploymentStatus["state"] = "queued") {
  const { location } = await temporary();
  let now = 1000000;
  let status: MacDeploymentStatus = {
    id: "job",
    revision,
    state,
    stage: "waiting_agent",
    updatedAt: now,
  };
  let ready = false;
  const options: AgentOptions = {
    home: location.home,
    revision,
    now: () => now,
    control: {
      snapshot: vi.fn<AgentOptions["control"]["snapshot"]>(async () => ({
        desiredRevision: revision,
        gatewayUrl: "https://gateway.test",
        status,
      })),
      request: vi.fn<AgentOptions["control"]["request"]>(async () => {
        status = { ...status, id: `request_${now}`, state: "queued" };
        return status;
      }),
      claim: vi.fn<AgentOptions["control"]["claim"]>(async () => ({ status, lease: "lease" })),
      report: vi.fn<AgentOptions["control"]["report"]>(async (_agentId, _lease, next) => {
        status = next;
        return status;
      }),
    },
    healthy: vi.fn<AgentOptions["healthy"]>(async () => ready),
    own: vi.fn<AgentOptions["own"]>(async () => {}),
    recover: vi.fn<AgentOptions["recover"]>(async () => {}),
    apply: vi.fn<AgentOptions["apply"]>(async (_target, progress) => {
      await progress("starting", "gateway");
      ready = true;
    }),
    log: vi.fn<AgentOptions["log"]>(),
  };
  return {
    options,
    status: () => status,
    ready: (value: boolean) => {
      ready = value;
    },
    advance: () => {
      now += 1000000;
    },
    journal: (attempts: number, retryAt = 0, operationId = "job") =>
      atomicFile(
        join(location.home, "journal.json"),
        JSON.stringify({ revision, operationId, attempts, retryAt }),
      ),
  };
}

test("an installed agent repairs once, reports exact revisions, then remains idle across restarts", async () => {
  const f = await fixture();
  await runDeploymentAgent(f.options);
  expect(f.status()).toMatchObject({
    state: "ready",
    gatewayRevision: revision,
    socialRevision: revision,
    agentRevision: revision,
  });
  expect(f.options.apply).toHaveBeenCalledOnce();
  const identity = await readFile(join(f.options.home, "agent-id"), "utf8");
  expect(f.options.control.claim).toHaveBeenCalledWith(identity, "job");
  await runDeploymentAgent(f.options);
  expect(f.options.apply).toHaveBeenCalledOnce();
  expect(f.options.control.claim).toHaveBeenCalledOnce();
  expect(await exists(join(f.options.home, "active"))).toBe(false);
});

test("automatic recovery is bounded with persisted backoff, while a new operator request resets its budget", async () => {
  const f = await fixture("waiting_agent");
  f.options.apply = vi.fn<AgentOptions["apply"]>(async () => {
    throw new DeploymentFailure("MAC_DOCKER_UNAVAILABLE");
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await runDeploymentAgent(f.options);
    expect(f.status().state).toBe("failed");
    await runDeploymentAgent(f.options);
    expect(f.options.apply).toHaveBeenCalledTimes(attempt);
    f.advance();
  }
  await runDeploymentAgent(f.options);
  expect(f.options.apply).toHaveBeenCalledTimes(3);
  await f.options.control.request();
  await runDeploymentAgent(f.options);
  expect(f.options.apply).toHaveBeenCalledTimes(4);
  expect(JSON.parse(await readFile(join(f.options.home, "journal.json"), "utf8"))).toMatchObject({
    attempts: 1,
  });
});

test.each(["MAC_ARTIFACT_NOT_READY", "MAC_LEGACY_UPDATER_BUSY"])(
  "defers %s with backoff and does not retain the diagnostic after success",
  async (code) => {
    const f = await fixture();
    const apply = f.options.apply;
    f.options.apply = vi.fn<AgentOptions["apply"]>(async () => {
      throw new DeploymentFailure(code);
    });
    await runDeploymentAgent(f.options);
    expect(f.status()).toMatchObject({ state: "queued", code });
    await runDeploymentAgent(f.options);
    expect(f.options.apply).toHaveBeenCalledOnce();
    f.advance();
    f.options.apply = apply;
    await runDeploymentAgent(f.options);
    expect(f.status().state).toBe("ready");
    expect(f.status().code).toBeUndefined();
  },
);

test("ready runtime can acknowledge an explicit repair without reinstalling", async () => {
  const f = await fixture("waiting_agent");
  f.ready(true);
  await runDeploymentAgent(f.options);
  expect(f.options.control.request).toHaveBeenCalledOnce();
  expect(f.options.apply).not.toHaveBeenCalled();
  expect(f.status().state).toBe("ready");
});

test.each([new Error("private text"), new DeploymentFailure("MAC_SPECIFIC")])(
  "failures remain sanitized and are recorded before a report can fail",
  async (failure) => {
    const f = await fixture();
    f.options.apply = async () => {
      throw failure;
    };
    const report = f.options.control.report;
    f.options.control.report = async (...args) => {
      if (args[2].state === "failed") throw new Error("control unavailable");
      return report(...args);
    };
    await expect(runDeploymentAgent(f.options)).rejects.toThrow("control unavailable");
    expect(f.options.log).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        code: failure instanceof DeploymentFailure ? "MAC_SPECIFIC" : "MAC_DEPLOYMENT_FAILED",
      }),
    );
    expect(JSON.stringify(vi.mocked(f.options.log).mock.calls)).not.toContain("private text");
    expect(await exists(join(f.options.home, "active"))).toBe(false);
  },
);

test("public health failure and interrupted retry exhaustion are terminal", async () => {
  const f = await fixture();
  f.options.apply = async () => {};
  await runDeploymentAgent(f.options);
  expect(f.status().code).toBe("MAC_PUBLIC_HEALTH_FAILED");
  const exhausted = await fixture();
  await exhausted.journal(6);
  await runDeploymentAgent(exhausted.options);
  expect(exhausted.status().code).toBe("MAC_RECOVERY_RETRY_LIMIT");
  expect(exhausted.options.apply).not.toHaveBeenCalled();
});

test("live locks and newborn lock directories prevent concurrent work; abandoned locks recover", async () => {
  const f = await fixture();
  const lock = join(f.options.home, "active");
  await atomicFile(join(lock, "pid"), String(process.pid));
  await runDeploymentAgent(f.options);
  expect(f.options.control.snapshot).not.toHaveBeenCalled();
  await atomicFile(join(lock, "pid"), "invalid");
  await runDeploymentAgent(f.options);
  expect(f.options.control.snapshot).not.toHaveBeenCalled();
  const old = new Date(Date.now() - 120000);
  await utimes(lock, old, old);
  await runDeploymentAgent(f.options);
  expect(f.status().state).toBe("ready");
  await mkdir(lock);
  await atomicFile(join(lock, "pid"), "2147483647");
  await runDeploymentAgent(f.options);
  expect(f.options.control.snapshot).toHaveBeenCalledTimes(2);
});

test("simultaneous launch requests elect only one installer", async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 8 }, () => runDeploymentAgent(f.options)));
  expect(f.options.apply).toHaveBeenCalledOnce();
});

test("unwritable lock storage fails visibly rather than starting uncoordinated work", async () => {
  const f = await fixture();
  await mkdir(f.options.home, { recursive: true });
  await chmod(f.options.home, 0o500);
  try {
    await expect(runDeploymentAgent(f.options)).rejects.toMatchObject({ code: "EACCES" });
  } finally {
    await chmod(f.options.home, 0o700);
  }
});

test("a newer API artifact supersedes an older pending repair", async () => {
  const f = await fixture();
  const snapshot = f.options.control.snapshot;
  f.options.control.snapshot = async () => ({
    ...(await snapshot()),
    status: { ...f.status(), revision: "b".repeat(40) },
  });
  await runDeploymentAgent(f.options);
  expect(f.options.control.request).toHaveBeenCalledOnce();
  expect(f.options.apply).toHaveBeenCalledWith(revision, expect.any(Function));
});
