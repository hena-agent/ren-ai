import { execFile } from "node:child_process";

export type DeploymentCommand = (
  program: string,
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<string>;
export class DeploymentFailure extends Error {
  constructor(
    readonly code: string,
    readonly exitCode?: number,
    readonly causeCode?: string,
  ) {
    super(code);
  }
}
/** Capture command output for parsing, never copy payload-bearing stderr into diagnostics. */
export const deploymentCommand: DeploymentCommand = (program, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      program,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: options.timeout ?? 120000,
        env: { ...process.env, NO_COLOR: "1", ...options.env },
      },
      (error, stdout) => {
        if (error) {
          const code =
            typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code)
              ? error.code
              : "MAC_SUBPROCESS_FAILED";
          const failure = new DeploymentFailure(
            "MAC_COMMAND_FAILED",
            typeof error.code === "number" ? error.code : undefined,
            code,
          );
          failure.cause = Object.assign(new Error("Mac deployment subprocess failed"), { code });
          reject(failure);
        } else resolve(stdout);
      },
    );
  });
