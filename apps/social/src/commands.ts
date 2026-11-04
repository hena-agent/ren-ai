import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import type { SocialAuthAccount } from "@ren-ai/onboarding/social-auth";
import type { SocialImageData } from "@ren-ai/onboarding/social-images";
import { withImageUpload } from "./image-upload.ts";

export const browserAccount = (account: Pick<SocialAuthAccount, "platform" | "id">) =>
  account.platform === "threads" ? `threads:${account.id}` : account.id;

export interface BrowserCommands {
  withImage?: <T>(image: SocialImageData, operation: (path: string) => Promise<T>) => Promise<T>;
  open: (account: string, url?: string) => Promise<number>;
  command: (
    account: string,
    port: number,
    args: readonly string[],
    signal: AbortSignal,
    input?: string,
  ) => Promise<string>;
}
/** Auth vault and stdin-batch behavior are verified against this CLI release. */
export async function requireAuthenticationVersion(
  commands: BrowserCommands,
  account: string,
  port: number,
  signal: AbortSignal,
) {
  if (
    (await commands.command(account, port, ["--version"], signal)).trim() !== "agent-browser 0.41.0"
  )
    throw new Error("agent-browser 0.41.0 is required for encrypted authentication");
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
  // macOS Unix sockets have a 103-byte path limit; SOCIAL_HOME may contain long GUI paths.
  const socketDirectory = `/tmp/renai-social-${process.getuid!()}-${createHash("sha256").update(home).digest("hex").slice(0, 12)}`;
  const open = (account: string, url = "https://x.com/home"): Promise<number> => {
    const directory = join(home, "profiles", account);
    const previous = browsers.get(account);
    if (previous)
      return previous.then(async () => {
        try {
          return await debuggingPort(directory);
        } catch {
          browsers.delete(account);
          return open(account, url);
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
          url,
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
  const command: BrowserCommands["command"] = async (account, port, args, signal, input) => {
    await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
    await chmod(socketDirectory, 0o700);
    return new Promise<string>((resolve, reject) => {
      const child = execFile(
        agentBrowser,
        [
          "--session",
          `renai-${createHash("sha256").update(account).digest("hex").slice(0, 32)}`,
          ...(args[0] === "auth" || args[0] === "--version" ? [] : ["--cdp", String(port)]),
          "--json",
          ...args,
        ],
        {
          signal,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            HOME: join(home, "agent-browser"),
            AGENT_BROWSER_SOCKET_DIR: socketDirectory,
          },
        },
        (error, stdout) => {
          if (error) {
            browsers.delete(account);
            return reject(
              Object.assign(
                new Error("agent-browser execution failed", {
                  cause: input === undefined ? error : new Error("Private browser command failed"),
                }),
                {
                  code: "SOCIAL_BROWSER_COMMAND",
                },
              ),
            );
          }
          resolve(stdout);
        },
      );
      child.stdin!.on("error", () => undefined);
      child.stdin!.end(input);
    });
  };
  return {
    open,
    command,
    withImage: <T>(image: SocialImageData, operation: (path: string) => Promise<T>) =>
      withImageUpload(home, image, operation),
  };
}
