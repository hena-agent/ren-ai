import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { messagingFixture } from "./messaging.test-helper.ts";

const listeningPort = async (server: ReturnType<typeof createServer>) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No process fixture listener");
  return address.port;
};

const awaitCatalog = async (url: string, child: ChildProcess) => {
  let reply = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Bun entry exited before readiness");
    try {
      const response = await fetch(`${url}/rpc`, {
        method: "POST",
        headers: { authorization: "Bearer test-application", "content-type": "application/ndjson" },
        body: `${JSON.stringify({ _tag: "Request", id: "0", tag: "catalog", payload: null, headers: [] })}\n`,
        signal: AbortSignal.timeout(200),
      });
      reply = await response.text();
      if (response.ok && reply.includes("persona1")) return;
    } catch {
      /* the child may still be opening its listener */
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Bun entry catalog did not become ready: ${reply}`);
};

export const withServerEntry = async <A>(
  story: (fixture: {
    readonly url: string;
    readonly backendRequests: ReadonlyArray<string>;
  }) => Promise<A>,
) => {
  const { root, personaDirectory } = await messagingFixture("server-entry-process-");
  const backendRequests: Array<string> = [];
  const backend = createServer((request, response) => {
    backendRequests.push(request.url ?? "");
    response.writeHead(503);
    response.end("No backend calls during bootstrap");
  });
  const backendPort = await listeningPort(backend);
  const reserve = createServer();
  const port = await listeningPort(reserve);
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const entry =
    process.env["REN_AI_TEST_SERVER_ENTRY"] ??
    fileURLToPath(new URL("../src/server-entry.ts", import.meta.url));
  const bundled = join(root, "application-entry.js");
  const built = spawnSync("bun", ["build", "--target=bun", `--outfile=${bundled}`, entry], {
    encoding: "utf8",
  });
  if (built.status !== 0) throw new Error(`Actual Bun entry build failed: ${built.stderr}`);
  const child = spawn("bun", [bundled], {
    cwd: root,
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "xdg-state"),
      STATE_DIRECTORY: join(root, "state"),
      PERSONA_DIRECTORY: personaDirectory,
      PORT: String(port),
      LISTEN_HOST: "127.0.0.1",
      BOOTSTRAP_ONLY: "true",
      IMSG_URL: `http://127.0.0.1:${backendPort}/imsg`,
      IMSG_TOKEN: "test-messaging",
      OPENCODE_URL: `http://127.0.0.1:${backendPort}/opencode`,
      OPENCODE_AUTHORIZATION: "Basic test-only",
      PERSONA_MODEL: "test/probe",
      TURNSTILE_SECRET: "test-turnstile",
      REN_AI_APPLICATION_TOKEN: "test-application",
      DISCORD_WEBHOOK_URL: `http://127.0.0.1:${backendPort}/discord`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let output = "";
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const url = `http://127.0.0.1:${port}`;
  try {
    await awaitCatalog(url, child).catch((error: Error) => {
      throw new Error(`${error.message}: ${output}`, { cause: error });
    });
    return await story({ url, backendRequests });
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(timer);
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
};
