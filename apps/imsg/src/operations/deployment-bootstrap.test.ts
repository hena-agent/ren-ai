import { join } from "node:path";
import { readFile, rm, stat } from "node:fs/promises";
import { expect, test } from "vitest";
import { Schema } from "effect";
import { ensureMacDeploymentAgent } from "./deployment-bootstrap.ts";
import { atomicFile, discoverDeployment, exists, DeploymentLocation } from "./deployment-files.ts";
import { deploymentTestContext } from "./deployment.test-helper.ts";

const fixture = deploymentTestContext();
async function setup() {
  const f = await fixture();
  const home = join(f.root, "Library/Application Support/ren-ai-api-msg");
  const entry = join(f.location.messagingHome, "imsg.js");
  await atomicFile(entry, "attested messaging bundle");
  await atomicFile(join(f.location.messagingHome, "deploy/token"), "secret");
  await atomicFile(join(home, "api-msg.env"), "secret env");
  const descriptor = join(f.root, "Library/LaunchAgents/im.renai.api-msg-deploy.plist");
  await atomicFile(descriptor, "plist");
  const docker = join(f.root, "docker-bin/docker");
  await atomicFile(docker, "docker");
  f.run.mockImplementation(async (program, args) => {
    if (program === "/usr/bin/plutil" && args.includes("-o"))
      return JSON.stringify({
        ProgramArguments: ["bash", "helper", "api-msg", home],
        EnvironmentVariables: { PATH: join(f.root, "docker-bin") },
      });
    if (args[0] === "print") throw new Error("not installed");
    return "";
  });
  return {
    ...f,
    entry,
    home,
    docker,
    descriptor,
    options: { entry, bun: f.location.bun, userHome: f.root, uid: 501, run: f.run },
    agentHome: join(f.root, "Library/Application Support/ren-ai-mac-deployment"),
  };
}

test("the legacy messaging payload enrolls an owner-only periodic agent without changing service credentials", async () => {
  const f = await setup();
  await ensureMacDeploymentAgent(f.options);
  expect(await readFile(join(f.agentHome, "agent.js"), "utf8")).toBe("attested messaging bundle");
  const installed = Schema.decodeUnknownSync(Schema.fromJsonString(DeploymentLocation))(
    await readFile(join(f.agentHome, "location.json"), "utf8"),
  );
  expect(installed).toMatchObject({ apiMsgHome: f.home, docker: f.docker });
  const plist = await readFile(
    join(f.root, "Library/LaunchAgents/im.renai.mac-deployment.plist"),
    "utf8",
  );
  expect(plist).toContain("--mac-deployment");
  expect(plist).toContain('"StartInterval":60');
  expect(plist).not.toContain("secret");
  expect((await stat(join(f.agentHome, "agent.js"))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(f.home, "api-msg.env"), "utf8")).toBe("secret env");
  const run = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (...args) => (args[1][0] === "print" ? "" : run(...args)));
  await ensureMacDeploymentAgent(f.options);
  expect(f.run.mock.calls.filter(([, args]) => args[0] === "bootstrap")).toHaveLength(1);
  await atomicFile(f.entry, "next attested bundle");
  await ensureMacDeploymentAgent(f.options);
  expect(f.run).toHaveBeenCalledWith("/bin/launchctl", [
    "bootout",
    "gui/501/im.renai.mac-deployment",
  ]);
  expect(await readFile(join(f.agentHome, "agent.js"), "utf8")).toBe("next attested bundle");
});

test("bootstrap preserves an in-progress repair and retries failed enrollment", async () => {
  const f = await setup();
  await atomicFile(join(f.agentHome, "active/pid"), String(process.pid));
  await ensureMacDeploymentAgent(f.options);
  expect(await exists(join(f.agentHome, "agent.js"))).toBe(false);
  await rm(join(f.agentHome, "active"), { recursive: true });
  const run = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (...args) => {
    if (args[1][0] === "bootstrap") throw new Error("launch failed");
    return run(...args);
  });
  await expect(ensureMacDeploymentAgent(f.options)).rejects.toThrow("launch failed");
  expect(await exists(join(f.agentHome, "bundle.sha256"))).toBe(false);
});

test("discovery fails closed when credentials, configured paths or Docker cannot be found", async () => {
  const f = await setup();
  await expect(
    discoverDeployment("relative.js", f.root, f.location.bun, f.run),
  ).rejects.toMatchObject({ code: "MAC_DEPLOY_CREDENTIALS_MISSING" });
  await rm(join(f.location.messagingHome, "deploy/token"));
  await expect(discoverDeployment(f.entry, f.root, f.location.bun, f.run)).rejects.toMatchObject({
    code: "MAC_DEPLOY_CREDENTIALS_MISSING",
  });
  await atomicFile(join(f.location.messagingHome, "deploy/token"), "secret");
  for (const args of [[], ["relative"]]) {
    f.run.mockResolvedValue(JSON.stringify({ ProgramArguments: args }));
    await expect(discoverDeployment(f.entry, f.root, f.location.bun, f.run)).rejects.toMatchObject({
      code: "MAC_DEPLOY_LOCATION_INVALID",
    });
  }
  await rm(f.descriptor);
  await rm(join(f.home, "api-msg.env"));
  await expect(discoverDeployment(f.entry, f.root, f.location.bun, f.run)).rejects.toMatchObject({
    code: "MAC_API_CONFIG_MISSING",
  });
});
