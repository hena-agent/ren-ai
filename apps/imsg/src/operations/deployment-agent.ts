import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import type { DeploymentLease, MacDeploymentStatus } from "@ren-ai/transport/deployment";
import type { DeploymentControl } from "./deployment-control.ts";
import { atomicFile, readOptional, deploymentActive, exists } from "./deployment-files.ts";
import { DeploymentFailure } from "./deployment-command.ts";

const Journal = Schema.fromJsonString(
  Schema.Struct({
    revision: Schema.String,
    operationId: Schema.String,
    attempts: Schema.Number,
    retryAt: Schema.Number,
  }),
);
export type AgentOptions = {
  home: string;
  revision: string;
  control: DeploymentControl;
  now: () => number;
  healthy: (gatewayUrl: string, revision: string) => Promise<boolean>;
  own: () => Promise<void>;
  recover: () => Promise<void>;
  apply: (
    revision: string,
    progress: (state: MacDeploymentStatus["state"], stage: string) => Promise<void>,
  ) => Promise<void>;
  log: (event: {
    operationId: string;
    stage: string;
    outcome: string;
    durationMs: number;
    code?: string;
    exitCode?: number;
    causeCode?: string;
  }) => void;
};
export async function runDeploymentAgent(options: AgentOptions) {
  const lock = join(options.home, "active");
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  if (await exists(lock)) {
    if (await deploymentActive(lock)) return;
    await rm(lock, { recursive: true, force: true });
  }
  try {
    await mkdir(lock);
  } catch (error) {
    if (Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }))(error)) return;
    throw error;
  }
  await atomicFile(join(lock, "pid"), String(process.pid));
  try {
    await cycle(options);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
async function cycle(options: AgentOptions) {
  const snapshot = await options.control.snapshot();
  const file = join(options.home, "journal.json");
  const decoded = await readOptional(file);
  const prior = decoded ? Schema.decodeUnknownSync(Journal)(decoded) : undefined;
  const active = ["queued", "installing", "starting", "verifying"].includes(snapshot.status.state);
  const healthy = await options.healthy(snapshot.gatewayUrl, snapshot.desiredRevision);
  if (
    !active &&
    healthy &&
    snapshot.status.state === "ready" &&
    snapshot.status.revision === snapshot.desiredRevision
  )
    return;
  if (
    !active &&
    !healthy &&
    prior?.revision === snapshot.desiredRevision &&
    (prior.attempts >= 3 || prior.retryAt > options.now())
  )
    return;
  const requested =
    active && snapshot.status.revision === snapshot.desiredRevision
      ? snapshot.status
      : await options.control.request();
  if (prior?.operationId === requested.id && prior.retryAt > options.now()) return;
  const agentId = await readAgentId(options.home);
  const lease = await options.control.claim(agentId, requested.id);
  const attempts =
    prior?.revision === requested.revision && (!active || prior.operationId === requested.id)
      ? prior.attempts + 1
      : 1;
  const journal = {
    revision: requested.revision,
    operationId: requested.id,
    attempts,
    retryAt: options.now() + Math.min(900000, 60000 * 2 ** (attempts - 1)),
  };
  await atomicFile(file, JSON.stringify(journal));
  await repair(options, { lease, agentId, attempts, healthy, gatewayUrl: snapshot.gatewayUrl });
}
async function readAgentId(home: string) {
  let agentId = await readOptional(join(home, "agent-id"));
  if (!agentId) {
    agentId = randomUUID();
    await atomicFile(join(home, "agent-id"), agentId);
  }
  return agentId;
}
async function repair(
  options: AgentOptions,
  attempt: {
    lease: DeploymentLease;
    agentId: string;
    attempts: number;
    healthy: boolean;
    gatewayUrl: string;
  },
) {
  const { lease, agentId, attempts, healthy, gatewayUrl } = attempt;
  const requested = lease.status;
  const started = options.now();
  let currentStage = "ownership";
  const report = (state: MacDeploymentStatus["state"], stage: string, code?: string) => {
    currentStage = stage;
    return options.control.report(agentId, lease, {
      id: requested.id,
      revision: requested.revision,
      state,
      stage,
      agentRevision: options.revision,
      updatedAt: options.now(),
      ...(code && { code }),
      ...(state === "ready" && {
        gatewayRevision: requested.revision,
        socialRevision: requested.revision,
      }),
    });
  };
  try {
    if (!healthy && attempts > 6) throw new DeploymentFailure("MAC_RECOVERY_RETRY_LIMIT");
    await options.own();
    await report("installing", "artifact");
    await options.recover();
    if (!healthy)
      await options.apply(requested.revision, async (state, stage) => {
        await report(state, stage);
      });
    await report("verifying", "public_health");
    if (!(await options.healthy(gatewayUrl, requested.revision)))
      throw new DeploymentFailure("MAC_PUBLIC_HEALTH_FAILED");
    await report("ready", "complete");
    options.log({
      operationId: requested.id,
      stage: "complete",
      outcome: "ready",
      durationMs: options.now() - started,
    });
  } catch (cause) {
    const code = cause instanceof DeploymentFailure ? cause.code : "MAC_DEPLOYMENT_FAILED";
    const deferred =
      ["MAC_ARTIFACT_NOT_READY", "MAC_LEGACY_UPDATER_BUSY"].includes(code) && attempts < 6;
    options.log({
      operationId: requested.id,
      stage: currentStage,
      outcome: "failed",
      code,
      ...(cause instanceof DeploymentFailure &&
        cause.exitCode !== undefined && { exitCode: cause.exitCode }),
      ...(cause instanceof DeploymentFailure && cause.causeCode && { causeCode: cause.causeCode }),
      durationMs: options.now() - started,
    });
    await report(
      deferred ? "queued" : "failed",
      deferred ? "waiting_artifact" : currentStage,
      code,
    );
  }
}
