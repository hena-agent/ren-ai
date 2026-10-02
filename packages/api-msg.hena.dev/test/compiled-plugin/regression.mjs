import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

// Explicit integration entry: node packages/api-msg.hena.dev/test/compiled-plugin/regression.mjs
// Requires the locally built plugin artifact and compiled CLI images, not live services or credentials.
const root = mkdtempSync(join(tmpdir(), "compiled-persona-plugin-"));
const name = `ren-ai-plugin-regression-${randomUUID()}`;
const artifact = `${name}-artifact`;
/** @param {string[]} args */
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 });
const auth = `Authorization: Basic ${Buffer.from("opencode:isolated-regression-password").toString("base64")}`;
/** @param {string} path @param {object | undefined} body @param {number} port */
function request(path, body, port = 4096) {
  const args = ["exec", name, "wget", "-qO-", "--timeout=10", "--header", auth];
  if (body !== undefined)
    args.push("--header", "Content-Type: application/json", "--post-data", JSON.stringify(body));
  const output = docker(...args, `http://127.0.0.1:${port}/${path}`);
  return output;
}
try {
  docker("create", "--name", artifact, "--entrypoint", "true", "ren-ai/plugin:local");
  docker("cp", `${artifact}:/artifact/plugin`, join(root, "plugin"));
  symlinkSync("plugin/node_modules", join(root, "node_modules"), "dir");
  if (!process.argv.includes("--artifact-only"))
    execFileSync(
      "bun",
      [
        "build",
        "--target=bun",
        "--packages=external",
        `--outfile=${join(root, "plugin/index.js")}`,
        fileURLToPath(new URL("../../src/opencode/remote-plugin.ts", import.meta.url)),
      ],
      { stdio: "pipe" },
    );
  const entry = join(root, "plugin/index.js");
  writeFileSync(entry, `import "../fixture.mjs";\n${readFileSync(entry, "utf8")}`);
  copyFileSync(fileURLToPath(new URL("./fixture.mjs", import.meta.url)), join(root, "fixture.mjs"));
  writeFileSync(join(root, "application.token"), "isolated-application-token\n", { mode: 0o600 });
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({
      providers: {
        probe: {
          name: "Isolated Probe",
          package: "@ai-sdk/openai-compatible",
          settings: { baseURL: "http://127.0.0.1:4710/v1", apiKey: "isolated-fake" },
          models: {
            probe: {
              name: "Probe",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100000, output: 1000 },
            },
          },
        },
      },
      agents: { persona1: { mode: "primary" } },
      plugins: [
        {
          package: "/srv/ren-ai/plugin",
          options: {
            directory: "/srv/ren-ai",
            url: "http://127.0.0.1:4710/rpc",
            tokenFile: "/srv/ren-ai/application.token",
          },
        },
      ],
    }),
  );
  docker(
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    "none",
    "--mount",
    `type=bind,source=${root},target=/srv/ren-ai`,
    "--workdir",
    "/srv/ren-ai",
    "--env",
    "OPENCODE_SERVER_PASSWORD=isolated-regression-password",
    "--env",
    "HOME=/tmp/isolated-home",
    "--env",
    "XDG_CONFIG_HOME=/tmp/isolated-home/config",
    "--env",
    "XDG_DATA_HOME=/tmp/isolated-home/data",
    "--env",
    "XDG_STATE_HOME=/tmp/isolated-home/state",
    "--env",
    "XDG_CACHE_HOME=/tmp/isolated-home/cache",
    "--entrypoint",
    "opencode",
    process.env["COMPILED_OPENCODE_IMAGE"] ?? "ren-ai/opencode-pty-gcompat:2.0.19",
    "serve",
    "--hostname",
    "0.0.0.0",
    "--port",
    "4096",
  );
  assert.equal(docker("exec", name, "opencode", "--version").trim(), "opencode v2.0.19");
  docker(
    "exec",
    name,
    "sh",
    "-ec",
    `for attempt in $(seq 1 100); do wget -qO- --header '${auth}' http://127.0.0.1:4096/openapi.json >/dev/null 2>&1 && exit 0; sleep 0.05; done; exit 1`,
  );
  for (const [index, minutes] of [200, 60, 30.5, 59, 0, -1, "120"].entries()) {
    const session = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })),
    )(
      request("api/session", {
        agent: "persona1",
        model: { providerID: "probe", id: "probe" },
        location: { directory: "/srv/ren-ai" },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      }),
    ).data.id;
    request(`api/session/${session}/prompt`, { text: `compiled-case:${index}` });
    request(`api/experimental/session/${session}/wait`, {});
    const history = request(`api/session/${session}/message`, undefined);
    assert(!history.includes("Cannot convert a symbol to a number"), history);
    if (typeof minutes === "number" && minutes > 0)
      assert(history.includes(`isolated wait completed: ${minutes}`), history);
    else assert(history.includes('"status":"error"'), history);
  }
  assert.deepEqual(
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Number)))(
      request("waits", undefined, 4710),
    ),
    [200, 60, 30.5, 59],
  );
  assert.equal(JSON.parse(request("catalogs", undefined, 4710)), 2);
  process.stdout.write(
    "Compiled OpenCode 2.0.19: plugin recovers a startup outage; installed wait accepts positive numbers, preserves fractions, and rejects nonpositive input before RPC.\n",
  );
} catch (error) {
  process.stderr.write(docker("logs", "--tail", "20", name));
  throw error;
} finally {
  for (const container of [name, artifact]) {
    execFileSync("docker", ["rm", "--force", container], { stdio: "ignore" });
  }
  rmSync(root, { recursive: true, force: true });
}
