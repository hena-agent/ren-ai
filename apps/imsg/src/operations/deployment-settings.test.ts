import { join } from "node:path";
import { expect, test } from "vitest";
import { atomicFile } from "./deployment-files.ts";
import {
  deploymentCredentials,
  socialLaunchAgent,
  socialRuntimeSettings,
} from "./deployment-settings.ts";
import { deploymentTestContext } from "./deployment.test-helper.ts";

const fixture = deploymentTestContext();
test("gateway credentials are read through a private env file, never command arguments", async () => {
  const { location, run } = await fixture();
  run.mockResolvedValue(
    JSON.stringify({ TOKEN_MANAGEMENT: "secret", APPLICATION_API_URL: "https://api.test" }),
  );
  expect(await deploymentCredentials(location, run)).toEqual({
    token: "secret",
    origin: "https://api.test",
  });
  expect(JSON.stringify(run.mock.calls)).not.toContain("secret");
  run.mockResolvedValue(JSON.stringify({ TOKEN_MANAGEMENT: "secret" }));
  expect((await deploymentCredentials(location, run)).origin).toBe("https://api.renai.im");
  run.mockResolvedValue("{}");
  await expect(deploymentCredentials(location, run)).rejects.toMatchObject({
    code: "MAC_MANAGEMENT_TOKEN_MISSING",
  });
});

test("a first native install reuses configured state and ports, leaving credentials in the original env file", async () => {
  const { root, location, run } = await fixture();
  const home = join(root, "existing profile");
  run.mockResolvedValue(
    JSON.stringify({
      SOCIAL_HOME: home,
      SOCIAL_CHROME: "/existing/chrome",
      SOCIAL_PORT: "5523",
      OPENCODE_DIRECTORY: "/workspace",
      PERSONA_MODEL: "model",
      APPLICATION_API_URL: "https://api.test",
      OPENCODE_URL: "https://oc.test",
    }),
  );
  const settings = await socialRuntimeSettings(location, root, run);
  expect(settings).toMatchObject({
    SOCIAL_HOME: home,
    SOCIAL_PORT: "5523",
    OPENCODE_DIRECTORY: "/workspace",
    PERSONA_MODEL: "model",
  });
  const plist = socialLaunchAgent(location, settings, "/existing/chrome");
  expect(plist.ProgramArguments).toEqual([
    location.bun,
    `--env-file=${location.apiMsgHome}/api-msg.env`,
    `${location.apiMsgHome}/social.js`,
  ]);
  expect(plist.EnvironmentVariables).toMatchObject({
    SOCIAL_HOME: home,
    SOCIAL_CHROME: "/existing/chrome",
    SOCIAL_AGENT_BROWSER: `${location.apiMsgHome}/bin/agent-browser`,
  });
  expect(plist.KeepAlive).toBe(true);
});

test("an existing native service retains its independent profile, browser, port, directory and model", async () => {
  const { root, location, run } = await fixture();
  const plist = join(root, "Library/LaunchAgents/im.renai.social.plist");
  await atomicFile(plist, "private plist");
  run.mockImplementation(async (program, args, options) => {
    if (program === "/usr/bin/plutil")
      return JSON.stringify({
        ProgramArguments: ["bun", "--env-file=/private/social.env", "social.js"],
        EnvironmentVariables: {
          SOCIAL_HOME: join(root, "original"),
          SOCIAL_PORT: "5501",
          UNRELATED_SECRET: "never-copy",
        },
      });
    if (args[0] === "--env-file=/private/social.env") {
      return JSON.stringify({
        ...options?.env,
        SOCIAL_CHROME: "/canary",
        OPENCODE_DIRECTORY: "/original",
        PERSONA_MODEL: "original",
      });
    }
    return JSON.stringify({ SOCIAL_HOME: join(root, "wrong"), SOCIAL_PORT: "5407" });
  });
  expect(await socialRuntimeSettings(location, root, run)).toMatchObject({
    SOCIAL_HOME: join(root, "original"),
    SOCIAL_PORT: "5501",
    SOCIAL_CHROME: "/canary",
    OPENCODE_DIRECTORY: "/original",
    PERSONA_MODEL: "original",
  });
  expect(
    run.mock.calls.find(([, args]) => args[0] === "--env-file=/private/social.env")?.[2]?.env,
  ).not.toHaveProperty("UNRELATED_SECRET");
  run.mockImplementation(async (program) =>
    program === "/usr/bin/plutil"
      ? JSON.stringify({
          ProgramArguments: [],
          EnvironmentVariables: { SOCIAL_HOME: join(root, "only-plist") },
        })
      : "{}",
  );
  expect((await socialRuntimeSettings(location, root, run)).SOCIAL_HOME).toBe(
    join(root, "only-plist"),
  );
  run.mockImplementation(async (program) =>
    program === "/usr/bin/plutil" ? JSON.stringify({ ProgramArguments: [] }) : "{}",
  );
  await expect(socialRuntimeSettings(location, root, run)).rejects.toMatchObject({
    code: "MAC_EXISTING_PROFILE_LOCATION_UNKNOWN",
  });
});

test("default settings use a dedicated profile and reject relative profiles or invalid ports", async () => {
  const { root, location, run } = await fixture();
  run.mockResolvedValue("{}");
  expect(await socialRuntimeSettings(location, root, run)).toMatchObject({
    SOCIAL_HOME: join(location.apiMsgHome, "social-state"),
    SOCIAL_PORT: "5407",
    SOCIAL_CHROME: "",
    APPLICATION_API_URL: "https://api.renai.im",
    OPENCODE_URL: "https://oc.renai.im",
  });
  for (const port of ["0", "65536", "bad"]) {
    run.mockResolvedValue(JSON.stringify({ SOCIAL_PORT: port }));
    await expect(socialRuntimeSettings(location, root, run)).rejects.toMatchObject({
      code: "MAC_SOCIAL_PORT_INVALID",
    });
  }
  run.mockResolvedValue(JSON.stringify({ SOCIAL_HOME: "relative" }));
  await expect(socialRuntimeSettings(location, root, run)).rejects.toMatchObject({
    code: "MAC_PROFILE_LOCATION_INVALID",
  });
});
