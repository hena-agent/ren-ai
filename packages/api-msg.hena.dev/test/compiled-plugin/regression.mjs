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
import { Session } from "@opencode/schema";
import { folderFiles, renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { folderSnapshot } from "@ren-ai/plugin-session-folder/protocol";

/** @param {string} text */
const sessionData = (text) =>
  Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        data: Schema.Struct({
          id: Schema.String,
          title: Schema.optional(Schema.String),
          location: Schema.Struct({ directory: Schema.String }),
        }),
      }),
    ),
  )(text).data;

// Explicit integration entry: node packages/api-msg.hena.dev/test/compiled-plugin/regression.mjs
// Requires the locally built plugin artifact and compiled CLI images, not live services or credentials.
const root = mkdtempSync(join(tmpdir(), "compiled-persona-plugin-"));
const name = `ren-ai-plugin-regression-${randomUUID()}`;
const artifact = `${name}-artifact`;
const containers = [];
let started = false;
/** @param {string[]} args */
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 });
const auth = `Authorization: Basic ${Buffer.from("opencode:isolated-regression-password").toString("base64")}`;
/** @param {string} path @param {object | undefined} body @param {number} port */
function request(path, body, port = 4096) {
  const args = [
    "exec",
    name,
    "wget",
    "-qO-",
    "--timeout=10",
    "--header",
    auth,
    "--header",
    "x-opencode-directory: /srv/ren-ai",
  ];
  if (body !== undefined)
    args.push("--header", "Content-Type: application/json", "--post-data", JSON.stringify(body));
  try {
    return docker(...args, `http://127.0.0.1:${port}/${path}`);
  } catch (error) {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const http = `${body === undefined ? "GET" : "POST"} /${path} HTTP/1.1\r\nHost: localhost\r\n${auth}\r\nx-opencode-directory: /srv/ren-ai\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`;
    const encoded = Buffer.from(http).toString("base64");
    throw new Error(
      docker("exec", name, "sh", "-c", `echo ${encoded} | base64 -d | nc -w 1 127.0.0.1 ${port}`),
      { cause: error },
    );
  }
}
try {
  docker(
    "create",
    "--name",
    artifact,
    "--entrypoint",
    "true",
    process.env["COMPILED_PLUGIN_IMAGE"] ?? "ren-ai/plugin:local",
  );
  containers.push(artifact);
  docker("cp", `${artifact}:/artifact/plugins`, join(root, "plugins"));
  symlinkSync("plugins/tools/node_modules", join(root, "node_modules"), "dir");
  const plugins = ["tools", "context", "memory", "title", "session-folder"];
  for (const plugin of plugins) {
    const entry = join(root, "plugins", plugin, "src", "index.js");
    if (!process.argv.includes("--artifact-only"))
      execFileSync(
        "bun",
        [
          "build",
          "--target=bun",
          "--external=@opencode/*",
          "--external=effect",
          "--external=effect/*",
          `--outfile=${entry}`,
          fileURLToPath(new URL(`../../../plugins/${plugin}/src/index.ts`, import.meta.url)),
        ],
        { stdio: "pipe" },
      );
    writeFileSync(entry, `import "../../../fixture.mjs";\n${readFileSync(entry, "utf8")}`);
  }
  copyFileSync(fileURLToPath(new URL("./fixture.mjs", import.meta.url)), join(root, "fixture.mjs"));
  writeFileSync(join(root, "application.token"), "isolated-application-token\n", { mode: 0o600 });
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({
      providers: {
        probe: {
          name: "Isolated Probe",
          package: "@ai-sdk/openai-compatible",
          settings: {
            baseURL: "http://127.0.0.1:4710/v1",
            apiKey: "isolated-fake",
          },
          models: {
            probe: {
              name: "Probe",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100000, output: 1000 },
            },
          },
        },
      },
      plugins: plugins.map((plugin) => ({
        package: `/srv/ren-ai/plugins/${plugin}/src`,
        options: {
          directory: "/srv/ren-ai",
          url: "http://127.0.0.1:4710/rpc",
          tokenFile: "/srv/ren-ai/application.token",
        },
      })),
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
    "--log-level",
    "debug",
    "--print-logs",
  );
  started = true;
  containers.push(name);
  assert.equal(docker("exec", name, "opencode", "--version").trim(), "opencode v2.0.19");
  docker(
    "exec",
    name,
    "sh",
    "-ec",
    `for attempt in $(seq 1 100); do wget -qO- --header '${auth}' http://127.0.0.1:4096/openapi.json >/dev/null 2>&1 && exit 0; sleep 0.05; done; exit 1`,
  );
  const locationQuery = new URLSearchParams({
    "location[directory]": "/srv/ren-ai",
  }).toString();
  /** @param {string} method @param {object} input */
  const rpc = (method, input) =>
    Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ output: Schema.Union([Schema.String, folderSnapshot, Schema.Null]) }),
      ),
    )(request(`api/rpc/ren-ai.session-folders/${method}?${locationQuery}`, { input })).output;
  const persona = {
    id: "persona1",
    timeZone: "UTC",
    language: "en",
    openingLine: "Hello",
    memory: "Remember.",
    prompt: "Isolated test persona.",
  };
  const preprovisioned = process.argv.includes("--preprovisioned");
  const coldID = Session.ID.create();
  const initialSnapshot = renderSnapshot(persona, "Isolated native ground rules. Read her phone.");
  if (preprovisioned) await folderFiles(root).write(coldID, initialSnapshot);
  // The first location request is RPC provisioning: no warmup session or model call.
  const coldFolder = preprovisioned
    ? `/srv/ren-ai/sessions/${coldID}`
    : rpc("write", { folderID: coldID, snapshot: initialSnapshot });
  assert.equal(coldFolder, `/srv/ren-ai/sessions/${coldID}`);
  request("api/session", {
    id: coldID,
    agent: "persona1",
    model: { providerID: "probe", id: "probe" },
    location: { directory: coldFolder },
  });
  const loaded = request(`api/plugin?${locationQuery}`, undefined);
  for (const plugin of plugins)
    assert(
      loaded.includes(`ren-ai.${plugin}`),
      `${loaded}\n${request(`api/config?${locationQuery}`, undefined)}`,
    );
  let lastSession = "";
  for (const [index, minutes] of [
    200,
    60,
    30.5,
    55,
    0,
    -1,
    "120",
    "send",
    "read",
    "react",
  ].entries()) {
    const id = Session.ID.create();
    const snapshot = renderSnapshot(persona, "Isolated native ground rules. Read her phone.");
    if (preprovisioned) await folderFiles(root).write(id, snapshot);
    const folder = preprovisioned
      ? `/srv/ren-ai/sessions/${id}`
      : rpc("create", { folderID: id, snapshot, model: "probe/probe" });
    assert.equal(folder, `/srv/ren-ai/sessions/${id}`);
    const session = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })),
    )(
      preprovisioned
        ? request("api/session", {
            id,
            agent: "persona1",
            model: { providerID: "probe", id: "probe" },
            location: { directory: folder },
            permissions: [{ action: "*", resource: "*", effect: "allow" }],
          })
        : request(`api/session/${id}`, undefined),
    ).data.id;
    lastSession = session;
    request(`api/session/${session}/prompt`, {
      text: `compiled-case:${index}`,
    });
    request(`api/experimental/session/${session}/wait`, {});
    assert.equal(
      sessionData(request(`api/session/${session}`, undefined)).title,
      "Persona1 · isolated@example.com",
    );
    const history = request(`api/session/${session}/message`, undefined);
    assert(!history.includes("Cannot convert a symbol to a number"), history);
    if (index > 6) assert(history.includes(`isolated ${minutes} completed`), history);
    else if (typeof minutes === "number" && minutes > 0 && minutes <= 55)
      assert(history.includes(`isolated wait completed: ${minutes}`), history);
    else assert(history.includes('"status":"error"'), history);
  }
  assert.deepEqual(
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Number)))(
      request("waits", undefined, 4710),
    ),
    [30.5, 55],
  );
  request(`api/session/${lastSession}/compact`, {});
  request(`api/experimental/session/${lastSession}/wait`, {});
  assert(request(`api/session/${lastSession}/message`, undefined).includes("About him: isolated."));
  assert.equal(
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Number))(
      request("catalogs", undefined, 4710),
    ),
    0,
  );
  assert.deepEqual(
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
      request("actions", undefined, 4710),
    ),
    ["send", "read", "react"],
  );
  const modelRequests = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Array(
        Schema.Struct({
          tools: Schema.optional(
            Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
          ),
          messages: Schema.Array(Schema.Json),
        }),
      ),
    ),
  )(request("requests", undefined, 4710)).filter(
    (body) =>
      body.tools?.some((tool) => tool.function.name === "send") &&
      JSON.stringify(body).includes("compiled-case:") &&
      !JSON.stringify(body).includes("Write her Memory"),
  );
  assert(
    modelRequests.length >= 10,
    "Primary model requests must be observed for every compiled case",
  );
  assert(modelRequests.every((body) => JSON.stringify(body).includes("Isolated test persona.")));
  assert(
    modelRequests.every((body) => JSON.stringify(body).includes("Isolated native ground rules.")),
  );
  assert(
    !JSON.stringify(modelRequests).match(
      /Working directory:|Today's date:|# Code Mode|Skills provide specialized/,
    ),
  );
  if (!preprovisioned) {
    /** @param {string} path @param {string} method @param {object} [body] */
    const nativeHttp = (path, method, body) =>
      Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ status: Schema.Number, body: Schema.String })),
      )(
        request(
          "native-http",
          { path, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
          4710,
        ),
      );
    /** @param {string} method @param {object} input */
    const failure = (method, input) => {
      const response = nativeHttp(
        `/api/rpc/ren-ai.session-folders/${method}?${locationQuery}`,
        "POST",
        { input },
      );
      assert.equal(response.status, 400);
      return Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({ type: Schema.String, message: Schema.String, data: Schema.String }),
        ),
      )(response.body);
    };
    assert.deepEqual(rpc("read", { folderID: coldID }), initialSnapshot);
    assert.equal(
      rpc("create", { folderID: coldID, snapshot: initialSnapshot, model: "probe/probe" }),
      coldFolder,
    );
    const revised = renderSnapshot(
      { ...persona, prompt: "Remember the emerald scarf." },
      "Revised native rules.",
    );
    assert.equal(rpc("update", { folderID: coldID, snapshot: revised }), coldFolder);
    assert.deepEqual(rpc("read", { folderID: coldID }), revised);
    assert.match(failure("remove", { folderID: coldID }).message, /Cannot remove session folder/);
    const fresh = sessionData(
      request("api/session", {
        agent: "persona1",
        model: { providerID: "probe", id: "probe" },
        location: { directory: coldFolder },
      }),
    ).id;
    request(`api/session/${fresh}/prompt`, { text: "compiled-native-child" });
    request(`api/experimental/session/${fresh}/wait`, {});
    assert.equal(
      sessionData(request(`api/session/${fresh}`, undefined)).location.directory,
      `/srv/ren-ai/sessions/${fresh}`,
    );
    assert.deepEqual(rpc("read", { folderID: fresh }), revised);
    const fork = sessionData(request(`api/session/${fresh}/fork`, {})).id;
    request(`api/session/${fork}/prompt`, { text: "compiled-native-fork" });
    request(`api/experimental/session/${fork}/wait`, {});
    assert.equal(
      sessionData(request(`api/session/${fork}`, undefined)).location.directory,
      `/srv/ren-ai/sessions/${fork}`,
    );
    assert.deepEqual(rpc("read", { folderID: fork }), revised);
    assert.equal(nativeHttp(`/api/session/${coldID}`, "DELETE").status, 204);
    assert.equal(rpc("remove", { folderID: coldID }), null);
    assert.match(
      failure("update", { folderID: coldID, snapshot: revised }).message,
      /Cannot update session folder/,
    );
    assert.match(failure("read", { folderID: coldID }).message, /Cannot read session folder/);
    assert.deepEqual(rpc("read", { folderID: fresh }), revised);
  }
  process.stdout.write(
    preprovisioned
      ? "Debug only: preprovisioned folders bypass RPC/lifecycle checks; tool/title/context/Memory checks passed.\n"
      : "Compiled OpenCode 2.0.19: cold folder RPC provisioning, idempotent creation, updates, reads/errors, deletion, and native new/fork folders work; five standalone plugins load; all four tools, titles and Memory compaction work; no catalog fetch.\n",
  );
} catch (error) {
  if (started) process.stderr.write(docker("logs", "--tail", "20", name));
  throw error;
} finally {
  for (const container of containers) {
    execFileSync("docker", ["rm", "--force", container], { stdio: "ignore" });
  }
  rmSync(root, { recursive: true, force: true });
}
