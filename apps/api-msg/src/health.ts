import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type ExecutorHealth = { diskNearlyFull: boolean; screenLocked: boolean | null };
export type CommandRunner = (command: string, args: string[]) => Promise<string>;

export const nativeCommand: CommandRunner = async (command, args) => {
  const { stdout } = await exec(command, args);
  return stdout;
};

export const checkExecutorHealth = async (
  run: CommandRunner = nativeCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<ExecutorHealth> => {
  const disk = await run("/bin/df", ["-Pk", "/"]).catch(() => "");
  const usage = /\s(\d+)%\s/.exec(disk);
  const screen =
    platform === "darwin"
      ? await run("/usr/sbin/ioreg", ["-n", "Root", "-d1"]).catch(() => null)
      : null;
  return {
    diskNearlyFull: usage === null || Number(usage[1]) >= 90,
    screenLocked: screen === null ? null : screen.includes('"CGSSessionScreenIsLocked"=Yes'),
  };
};
