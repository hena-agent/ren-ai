import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import type { DeploymentCommand } from "./deployment-command.ts";
import type { DeploymentLocation } from "./deployment-files.ts";

export function deploymentTestContext() {
  const homes: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });
  return async () => {
    const root = await mkdtemp(join(tmpdir(), "renai mac deployment "));
    homes.push(root);
    const location: DeploymentLocation = {
      home: join(root, "agent"),
      messagingHome: join(root, "messaging"),
      apiMsgHome: join(root, "gateway"),
      bun: "/bin/bun",
      docker: "/bin/docker",
    };
    const run = vi.fn<DeploymentCommand>();
    return { root, location, run };
  };
}
