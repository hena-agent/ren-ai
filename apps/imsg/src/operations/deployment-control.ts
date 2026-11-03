import { Schema } from "effect";
import {
  DeploymentLease,
  DeploymentSnapshot,
  MacDeploymentStatus,
} from "@ren-ai/transport/deployment";
import { DeploymentFailure } from "./deployment-command.ts";
import { parseHealth } from "@ren-ai/transport/health";

function deploymentOrigin(origin: string, code: string) {
  const base = new URL(origin);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)))
  )
    throw new DeploymentFailure(code);
  return base;
}
export function deploymentControl(origin: string, token: string, fetcher: typeof fetch = fetch) {
  const base = deploymentOrigin(origin, "MAC_CONTROL_ORIGIN_INVALID");
  const call = async (path: string, body?: object) => {
    const response = await fetcher(new URL(`/management/social/deployment${path}`, base), {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body && { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new DeploymentFailure(
        response.status === 409 ? "MAC_CONTROL_CONFLICT" : "MAC_CONTROL_UNAVAILABLE",
      );
    return response.json();
  };
  return {
    snapshot: async () => Schema.decodeUnknownSync(DeploymentSnapshot)(await call("")),
    request: async () => Schema.decodeUnknownSync(MacDeploymentStatus)(await call("/request", {})),
    claim: async (agentId: string, operationId: string) =>
      Schema.decodeUnknownSync(DeploymentLease)(await call("/claim", { agentId, operationId })),
    report: async (agentId: string, lease: DeploymentLease, status: MacDeploymentStatus) =>
      Schema.decodeUnknownSync(MacDeploymentStatus)(
        await call("/report", {
          agentId,
          operationId: lease.status.id,
          lease: lease.lease,
          status,
        }),
      ),
  };
}
export type DeploymentControl = ReturnType<typeof deploymentControl>;
const Healthy = Schema.Struct({
  service: Schema.String,
  revision: Schema.String,
  status: Schema.String,
  social: Schema.Struct({ status: Schema.Literal("ready") }),
});
export async function publicRuntimeReady(
  url: string,
  revision: string,
  fetcher: typeof fetch = fetch,
) {
  const base = deploymentOrigin(url, "MAC_GATEWAY_ORIGIN_INVALID");
  try {
    const response = await fetcher(new URL("/health", base), {
      signal: AbortSignal.timeout(10000),
      redirect: "manual",
    });
    if (!response.ok) return false;
    const body = Schema.decodeUnknownSync(Healthy)(await response.json());
    return parseHealth(body, "api-msg", revision).status === "ready";
  } catch {
    return false;
  }
}
