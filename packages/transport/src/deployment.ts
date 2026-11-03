import { Schema } from "effect";

export const DeploymentRevision = Schema.String.check(
  Schema.isPattern(/^(?:[a-f0-9]{40}|development)$/),
);
const identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,80}$/));
export const DeploymentPhase = Schema.Literals([
  "waiting_agent",
  "queued",
  "installing",
  "starting",
  "verifying",
  "ready",
  "failed",
]);
export const MacDeploymentStatus = Schema.Struct({
  id: identifier,
  revision: DeploymentRevision,
  state: DeploymentPhase,
  stage: Schema.String.check(Schema.isPattern(/^[a-z_]{1,64}$/)),
  updatedAt: Schema.Number,
  code: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Z0-9_]{1,80}$/))),
  agentRevision: Schema.optionalKey(DeploymentRevision),
  gatewayRevision: Schema.optionalKey(DeploymentRevision),
  socialRevision: Schema.optionalKey(DeploymentRevision),
});
export type MacDeploymentStatus = typeof MacDeploymentStatus.Type;
export const DeploymentClaim = Schema.Struct({ agentId: identifier, operationId: identifier });
export const DeploymentReport = Schema.Struct({
  ...DeploymentClaim.fields,
  lease: identifier,
  status: MacDeploymentStatus,
});
export const DeploymentLease = Schema.Struct({ status: MacDeploymentStatus, lease: identifier });
export type DeploymentLease = typeof DeploymentLease.Type;
export const DeploymentSnapshot = Schema.Struct({
  desiredRevision: DeploymentRevision,
  gatewayUrl: Schema.String,
  status: MacDeploymentStatus,
});
export type DeploymentSnapshot = typeof DeploymentSnapshot.Type;
