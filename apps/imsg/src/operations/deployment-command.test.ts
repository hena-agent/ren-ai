import { expect, test } from "vitest";
import { deploymentCommand } from "./deployment-command.ts";

test("subprocess output is captured privately with explicit environment overrides", async () => {
  expect(
    await deploymentCommand(
      process.execPath,
      ["-e", "process.stdout.write(process.env.DEPLOY_TEST_VALUE)"],
      { env: { DEPLOY_TEST_VALUE: "value" } },
    ),
  ).toBe("value");
  expect(await deploymentCommand(process.execPath, ["-e", "process.stdout.write('ok')"])).toBe(
    "ok",
  );
});

test("failure diagnostics retain exit/error codes but never subprocess arguments or stderr", async () => {
  const failure = await deploymentCommand(process.execPath, [
    "-e",
    "process.stderr.write('private-password');process.exit(7)",
  ]).catch((cause: Error) => cause);
  expect(failure).toMatchObject({
    code: "MAC_COMMAND_FAILED",
    exitCode: 7,
    cause: { code: "MAC_SUBPROCESS_FAILED" },
  });
  expect(JSON.stringify(failure)).not.toContain("private-password");
  await expect(deploymentCommand("/nonexistent/renai-program", [])).rejects.toMatchObject({
    cause: { code: "ENOENT" },
  });
  await expect(
    deploymentCommand(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeout: 10 }),
  ).rejects.toMatchObject({ code: "MAC_COMMAND_FAILED" });
});
