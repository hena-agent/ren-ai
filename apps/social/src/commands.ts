import { execFile, spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";

export interface BrowserCommands {
  open: (account: string) => Promise<number>;
  command: (
    account: string,
    port: number,
    args: readonly string[],
    signal: AbortSignal,
  ) => Promise<string>;
}
const Envelope = Schema.Struct({
  success: Schema.Boolean,
  data: Schema.optionalKey(Schema.Struct({ result: Schema.optionalKey(Schema.String) })),
});

/** Decode only allowlisted CLI output, never relay payload-bearing stderr into diagnostics. */
export function commandResult(output: string) {
  try {
    const value = Schema.decodeUnknownSync(Schema.fromJsonString(Envelope))(output);
    if (!value.success) throw new Error("Browser command failed");
    return value.data?.result ?? "";
  } catch (cause) {
    throw new Error("Invalid agent-browser result", { cause });
  }
}

async function debuggingPort(directory: string) {
  const [raw, target] = (await readFile(join(directory, "DevToolsActivePort"), "utf8"))
    .trim()
    .split("\n");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid managed CDP port");
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) throw new Error("Managed CDP is unavailable");
  const value = Schema.decodeUnknownSync(Schema.Struct({ webSocketDebuggerUrl: Schema.String }))(
    await response.json(),
  );
  if (value.webSocketDebuggerUrl !== `ws://127.0.0.1:${port}${target}`)
    throw new Error("Managed CDP target changed");
  return port;
}

export function browserCommands(
  home: string,
  executable: string,
  agentBrowser: string,
): BrowserCommands {
  const browsers = new Map<string, Promise<number>>();
  const open = (account: string): Promise<number> => {
    const directory = join(home, "profiles", account);
    const previous = browsers.get(account);
    if (previous)
      return previous.then(async () => {
        try {
          return await debuggingPort(directory);
        } catch {
          browsers.delete(account);
          return open(account);
        }
      });
    const launched = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        return await debuggingPort(directory);
      } catch {
        /* No live browser owns this managed profile. */
      }
      const child = spawn(
        executable,
        [
          `--user-data-dir=${directory}`,
          "--remote-debugging-port=0",
          "--remote-debugging-address=127.0.0.1",
          "--no-first-run",
          "--lang=en-US",
          "https://x.com/home",
        ],
        { stdio: "ignore" },
      );
      child.once("exit", () => {
        if (browsers.get(account) === launched) browsers.delete(account);
      });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", resolve);
      });
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          return await debuggingPort(directory);
        } catch {
          /* Canary is still starting. */
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      child.kill();
      throw new Error("Chrome Canary CDP did not become ready");
    })();
    browsers.set(account, launched);
    void launched.catch(() => browsers.delete(account));
    return launched;
  };
  return {
    open,
    command: (account, port, args, signal) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          agentBrowser,
          ["--session", `ren-ai-${account}`, "--cdp", String(port), "--json", ...args],
          { signal, timeout: 30000, maxBuffer: 1024 * 1024 },
          (error, stdout) => {
            if (error) {
              browsers.delete(account);
              return reject(
                Object.assign(new Error("agent-browser execution failed", { cause: error }), {
                  code: "SOCIAL_BROWSER_COMMAND",
                }),
              );
            }
            resolve(stdout);
          },
        );
      }),
  };
}
