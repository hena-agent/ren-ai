import { expect, test, vi } from "vitest";
import { checkExecutorHealth, nativeCommand, type CommandRunner } from "./health.ts";

test("native command runner captures stdout", async () => {
  await expect(nativeCommand("/bin/echo", ["safe-probe"])).resolves.toContain("safe-probe");
});

test("health facts parse disk threshold and locked screen state", async () => {
  const run = vi
    .fn<CommandRunner>()
    .mockResolvedValueOnce(
      "Filesystem 1K-blocks Used Avail Capacity Mounted on\n/dev 100 90 10 90% /\n",
    )
    .mockResolvedValueOnce('"CGSSessionScreenIsLocked"=Yes');
  await expect(checkExecutorHealth(run, "darwin")).resolves.toEqual({
    diskNearlyFull: true,
    screenLocked: true,
  });
});

test("health allows disk usage below the near-full threshold", async () => {
  const run = vi
    .fn<CommandRunner>()
    .mockResolvedValueOnce("Filesystem 100 89 11 89% /\n")
    .mockResolvedValueOnce("");
  await expect(checkExecutorHealth(run, "darwin")).resolves.toEqual({
    diskNearlyFull: false,
    screenLocked: false,
  });
});

test("health marks malformed or unavailable disk facts as unsafe and an unlocked screen as false", async () => {
  const run = vi
    .fn<CommandRunner>()
    .mockResolvedValueOnce("no disk percentage")
    .mockResolvedValueOnce('"CGSSessionScreenIsLocked"=No');
  await expect(checkExecutorHealth(run, "darwin")).resolves.toEqual({
    diskNearlyFull: true,
    screenLocked: false,
  });
});

test("health tolerates failures of either native read", async () => {
  const run = vi.fn<CommandRunner>().mockRejectedValue(new Error("private command output"));
  await expect(checkExecutorHealth(run, "darwin")).resolves.toEqual({
    diskNearlyFull: true,
    screenLocked: null,
  });
});

test("Docker checks its filesystem and never invents a Mac screen state", async () => {
  const run = vi.fn<CommandRunner>().mockResolvedValue("Filesystem 100 42 58 42% /\n");
  await expect(checkExecutorHealth(run, "linux")).resolves.toEqual({
    diskNearlyFull: false,
    screenLocked: null,
  });
  expect(run).toHaveBeenCalledExactlyOnceWith("/bin/df", ["-Pk", "/"]);
  expect(typeof (await checkExecutorHealth()).diskNearlyFull).toBe("boolean");
});
