import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { buildRevision } from "@ren-ai/transport/health";
import {
  MacDeploymentStatus,
  type DeploymentClaim,
  type DeploymentReport,
} from "@ren-ai/transport/deployment";
import type { SocialStore } from "./store.ts";
import { SocialError } from "./service.ts";

type Record = { data: string; owner: string | null; lease: string | null; until: number | null };
export function macDeployment(store: SocialStore, now: () => number, gatewayUrl: string) {
  store.exec(
    "CREATE TABLE IF NOT EXISTS mac_deployment (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, owner TEXT, lease TEXT, until INTEGER)",
  );
  const read = () =>
    store.exec<Record>("SELECT data,owner,lease,until FROM mac_deployment WHERE id=1")[0];
  const status = (): MacDeploymentStatus => {
    const row = read();
    return row
      ? Schema.decodeUnknownSync(Schema.fromJsonString(MacDeploymentStatus))(row.data)
      : {
          id: "none",
          revision: buildRevision(),
          state: "waiting_agent",
          stage: "waiting_agent",
          updatedAt: 0,
        };
  };
  const request = () => {
    const current = status();
    if (
      current.revision === buildRevision() &&
      ["queued", "installing", "starting", "verifying"].includes(current.state)
    )
      return current;
    const next: MacDeploymentStatus = {
      id: randomUUID(),
      revision: buildRevision(),
      state: "queued",
      stage: "waiting_agent",
      updatedAt: now(),
    };
    store.exec(
      "INSERT INTO mac_deployment VALUES (1,?,NULL,NULL,NULL) ON CONFLICT(id) DO UPDATE SET data=excluded.data,owner=NULL,lease=NULL,until=NULL",
      JSON.stringify(next),
    );
    return next;
  };
  return {
    status,
    snapshot: () => ({ desiredRevision: buildRevision(), gatewayUrl, status: status() }),
    request,
    claim: (input: typeof DeploymentClaim.Type) => {
      const row = read();
      const current = status();
      if (
        !row ||
        current.id !== input.operationId ||
        !["queued", "installing", "starting", "verifying"].includes(current.state)
      )
        throw new SocialError(409, "MAC_DEPLOYMENT_NOT_PENDING");
      if (row.owner && row.owner !== input.agentId && row.until! > now())
        throw new SocialError(409, "MAC_DEPLOYMENT_LEASED");
      const lease = row.owner === input.agentId && row.until! > now() ? row.lease! : randomUUID();
      store.exec(
        "UPDATE mac_deployment SET owner=?,lease=?,until=? WHERE id=1",
        input.agentId,
        lease,
        now() + 1200000,
      );
      return { status: current, lease };
    },
    report: (input: typeof DeploymentReport.Type) => {
      const row = read();
      const current = status();
      if (
        !row ||
        row.owner !== input.agentId ||
        row.lease !== input.lease ||
        row.until! <= now() ||
        current.id !== input.operationId ||
        input.status.id !== current.id ||
        input.status.revision !== current.revision
      )
        throw new SocialError(409, "MAC_DEPLOYMENT_STALE");
      const next = { ...input.status, updatedAt: now() };
      const terminal = ["ready", "failed"].includes(next.state);
      store.exec(
        "UPDATE mac_deployment SET data=?,until=? WHERE id=1",
        JSON.stringify(next),
        terminal ? now() : now() + 1200000,
      );
      return next;
    },
  };
}
