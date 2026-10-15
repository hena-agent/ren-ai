import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type MacHealth = { diskNearlyFull: boolean; screenLocked: boolean };
export type CommandRunner = (command: string, args: string[]) => Promise<string>;

export const nativeCommand: CommandRunner = async (command, args) => {
  const { stdout } = await exec(command, args);
  return stdout;
};

export const checkMacHealth = async (run: CommandRunner = nativeCommand): Promise<MacHealth> => {
  const disk = await run("/bin/df", ["-Pk", "/"]).catch(() => "");
  const usage = /\s(\d+)%\s/.exec(disk);
  const screen = await run("/usr/sbin/ioreg", ["-n", "Root", "-d1"]).catch(() => "");
  return {
    diskNearlyFull: usage === null || Number(usage[1]) >= 90,
    screenLocked: screen.includes('"CGSSessionScreenIsLocked"=Yes'),
  };
};
