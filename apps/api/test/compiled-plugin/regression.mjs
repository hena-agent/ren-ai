import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { Schema } from "effect";
import { Session } from "@opencode/schema";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { folderSnapshot, personaFolderSnapshot } from "@ren-ai/plugin-session-folder/protocol";
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

// Run with Bun against the built artifact and compiled CLI; no live services or credentials.
const root = mkdtempSync(join(tmpdir(), "compiled-persona-plugin-"));
const name = `ren-ai-plugin-regression-${randomUUID()}`;
const artifact = `${name}-artifact`;
const containers = [];
let started = false;
let probing = false;
/** @param {string[]} args */
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 180_000 });
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
    throw new Error(`${body === undefined ? "GET" : "POST"} /${path} failed`, { cause: error });
  }
}
try {
  docker(
    "create",
    "--name",
    artifact,
    "--volume",
    "/artifact",
    "--entrypoint",
    "true",
    process.env["COMPILED_PLUGIN_IMAGE"] ?? "ren-ai/plugin:local",
  );
  containers.push(artifact);
  mkdirSync(join(root, "plugins"));
  symlinkSync("plugins/tools/node_modules", join(root, "node_modules"), "dir");
  const plugins = ["tools", "context", "memory", "title", "dice", "session-folder"];
  for (const plugin of plugins) {
    const target = join(root, "plugins", plugin);
    mkdirSync(target);
    docker("cp", `${artifact}:/artifact/plugins/${plugin}/src`, join(target, "src"));
    docker(
      "cp",
      `${artifact}:/artifact/plugins/${plugin}/package.json`,
      join(target, "package.json"),
    );
    symlinkSync(`/artifact/plugins/${plugin}/node_modules`, join(target, "node_modules"), "dir");
    const entry = join(root, "plugins", plugin, "src", "index.js");
    writeFileSync(entry, `import "../../../fixture.mjs";\n${readFileSync(entry, "utf8")}`);
  }
  docker(
    "cp",
    `${artifact}:/artifact/plugins/session-folder/templates`,
    join(root, "plugins", "session-folder", "templates"),
  );
  copyFileSync(fileURLToPath(new URL("./fixture.mjs", import.meta.url)), join(root, "fixture.mjs"));
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
              capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
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
    "--volumes-from",
    `${artifact}:ro`,
    "--mount",
    `type=bind,source=${root},target=/srv/ren-ai`,
    "--workdir",
    "/srv/ren-ai",
    "--env",
    "OPENCODE_SERVER_PASSWORD=isolated-regression-password",
    "--env",
    "TOKEN_MANAGEMENT=isolated-application-token",
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
    initial: {
      state:
        "---\nmood: 55\nenergy: 60\nstress: 30\nconnection: 65\nsolitude: 40\naffection: 23\ntraits: {}\n---\n",
      memory: "My own quiet studio.",
    },
  };
  const coldID = Session.ID.create();
  const initialSnapshot = {
    ...renderSnapshot(persona, "Isolated native ground rules. Read her phone."),
    binding: { personaID: persona.id, conversationKey: coldID, writable: true },
  };
  // The first location request is RPC provisioning: no warmup session or model call.
  const coldFolder = rpc("write", { folderID: coldID, snapshot: initialSnapshot });
  assert.equal(coldFolder, `/srv/ren-ai/personas/${persona.id}`);
  request("api/session", {
    id: coldID,
    agent: "persona1",
    model: { providerID: "probe", id: "probe" },
    location: { directory: coldFolder },
  });
  const loaded = request(`api/plugin?${locationQuery}`, undefined);
  probing = true;
  for (const plugin of plugins)
    assert(
      loaded.includes(`ren-ai.${plugin}`),
      `${loaded}\n${request(`api/config?${locationQuery}`, undefined)}`,
    );
  let lastSession = "";
  for (const [index, seconds] of [
    12000,
    3600,
    5.5,
    3300,
    0,
    -1,
    "120",
    "send",
    "read",
    "react",
  ].entries()) {
    const id = Session.ID.create();
    const snapshot = renderSnapshot(persona, "Isolated native ground rules. Read her phone.");
    const folder = rpc("create", {
      folderID: id,
      snapshot,
      model: "probe/probe",
      conversationKey: id,
    });
    assert.equal(folder, `/srv/ren-ai/personas/${persona.id}`);
    const session = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })),
    )(request(`api/session/${id}`, undefined)).data.id;
    lastSession = session;
    request(`api/session/${session}/prompt`, {
      text: `compiled-case:${index}`,
      ...(index === 7
        ? {
            files: [
              {
                uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
              },
            ],
          }
        : {}),
    });
    if (seconds === 3300) {
      let running = false;
      for (let attempt = 0; attempt < 100 && !running; attempt++) {
        running = request(`api/session/${session}/message`, undefined).includes(
          '"status":"running"',
        );
        if (!running) await setTimeout(100);
      }
      assert(running, "The compiled local wait must start before the interrupting input");
      request(`api/session/${session}/prompt`, {
        text: "A newly admitted message interrupts the local wait.",
      });
    }
    request(`api/experimental/session/${session}/wait`, {});
    assert.equal(
      sessionData(request(`api/session/${session}`, undefined)).title,
      "Persona1 · isolated@example.com",
    );
    const history = request(`api/session/${session}/message`, undefined);
    assert(!history.includes("Cannot convert a symbol to a number"), history);
    if (index > 6) assert(history.includes(`isolated ${seconds} completed`), history);
    else if (seconds === 3300) assert(history.includes("cut short by something new"), history);
    else if (typeof seconds === "number" && seconds > 0 && seconds <= 3300)
      assert(history.includes(`paused ${seconds}s`), history);
    else assert(history.includes('"status":"error"'), history);
  }
  const calls = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
    request("calls", undefined, 4710),
  );
  assert(calls.includes("context"), JSON.stringify(calls));
  assert(!calls.some((tag) => ["wait", "status", "sends"].includes(tag)));
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
    modelRequests.some((body) => JSON.stringify(body).includes("image_url")),
    "A photo must reach the provider through the separately loaded context plugin",
  );
  assert(
    modelRequests.every((body) => JSON.stringify(body).includes("Isolated native ground rules.")),
  );
  assert(
    !JSON.stringify(modelRequests).match(
      /Working directory:|Today's date:|# Code Mode|Skills provide specialized/,
    ),
  );
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
  const read = (/** @type {string} */ id) =>
    Schema.decodeUnknownSync(folderSnapshot)(rpc("read", { folderID: id }));
  request(`api/session/${coldID}/prompt`, { text: "compiled-shared:writer" });
  let queued = false;
  for (let attempt = 0; attempt < 100 && !queued; attempt++) {
    queued = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ queued: Schema.Boolean })),
    )(request("gate", undefined, 4710)).queued;
    if (!queued) await setTimeout(100);
  }
  assert(queued, "Bundled memory/dice tools must queue behind the persona lock");
  const blocked = request(`api/session/${coldID}/message`, undefined);
  assert.match(blocked, /"name":"update_state"/);
  assert.match(blocked, /"name":"dice"/);
  assert.equal((blocked.match(/"status":"running"/g) ?? []).length, 4);
  request(`api/session/${lastSession}/prompt`, { text: "compiled-shared:reader" });
  await setTimeout(100);
  assert(
    !request("requests", undefined, 4710).includes("compiled-shared:reader"),
    "The separately bundled context plugin must wait for the same persona lock",
  );
  assert.equal(
    readFileSync(join(root, "personas", persona.id, "conversations", coldID, "MEMORY.md"), "utf8"),
    "",
  );
  request("release", {}, 4710);
  request(`api/experimental/session/${coldID}/wait`, {});
  request(`api/experimental/session/${lastSession}/wait`, {});
  const written = read(coldID);
  assert.equal(written.runtime?.state?.energy, 68);
  assert.equal(written.runtime?.shortTerm, "Shared afternoon at the pottery studio.");
  assert.equal(written.relationship?.shortTerm, "Private violet promise with this user.");
  assert.equal(read(lastSession).relationship?.shortTerm, "");
  for (const [index, operation] of [
    "update_state",
    "update_memory",
    "update_memory",
    "dice",
  ].entries())
    assert.equal(written.runtime?.receipts[`${coldID}:shared-case-${index}`]?.operation, operation);
  const readerRequests = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Json)))(
    request("requests", undefined, 4710),
  )
    .map((body) => JSON.stringify(body))
    .filter((body) => body.includes("compiled-shared:reader"));
  assert(readerRequests.length > 0);
  assert(readerRequests.every((body) => body.includes("Shared afternoon at the pottery studio.")));
  assert(readerRequests.every((body) => !body.includes("Private violet promise")));
  const before = read(coldID);
  assert.deepEqual(before.persona, initialSnapshot.persona);
  assert.deepEqual(before.binding, initialSnapshot.binding);
  assert.equal(before.relationship?.state?.affection, 23);
  assert.equal(
    rpc("create", { folderID: coldID, snapshot: initialSnapshot, model: "probe/probe" }),
    coldFolder,
  );
  const revised = renderSnapshot(
    { ...persona, prompt: "Remember the emerald scarf." },
    "Revised native rules.",
  );
  assert.equal(rpc("update", { folderID: coldID, snapshot: revised }), coldFolder);
  const updated = read(coldID);
  assert.deepEqual(updated.persona, revised.persona);
  assert.equal(updated.agent, revised.agent);
  assert.equal(updated.rules, revised.rules);
  assert.deepEqual(updated.runtime, before.runtime);
  assert.deepEqual(updated.relationship, before.relationship);
  assert.deepEqual(read(lastSession).persona, revised.persona);
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
    `/srv/ren-ai/sandboxes/${fresh}`,
  );
  const freshSnapshot = read(fresh);
  assert.deepEqual(freshSnapshot.persona, revised.persona);
  assert.equal(freshSnapshot.binding?.conversationKey, fresh);
  const fork = sessionData(request(`api/session/${fresh}/fork`, {})).id;
  request(`api/session/${fork}/prompt`, { text: "compiled-native-fork" });
  request(`api/experimental/session/${fork}/wait`, {});
  assert.equal(
    sessionData(request(`api/session/${fork}`, undefined)).location.directory,
    `/srv/ren-ai/sandboxes/${fork}`,
  );
  const forkSnapshot = read(fork);
  assert.deepEqual(forkSnapshot.persona, revised.persona);
  assert.deepEqual(forkSnapshot.relationship, freshSnapshot.relationship);
  assert.equal(forkSnapshot.binding?.conversationKey, fork);
  assert.equal(nativeHttp(`/api/session/${coldID}`, "DELETE").status, 204);
  assert.equal(rpc("remove", { folderID: coldID }), null);
  assert.match(
    failure("update", { folderID: coldID, snapshot: revised }).message,
    /Cannot update session folder/,
  );
  assert.match(failure("read", { folderID: coldID }).message, /Cannot read session folder/);
  assert.deepEqual(read(fresh).persona, revised.persona);
  assert.match(
    readFileSync(join(root, "personas", persona.id, "conversations", coldID, "STATE.md"), "utf8"),
    /affection: 23/,
  );
  const inventory = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ output: Schema.Array(personaFolderSnapshot) })),
  )(request(`api/rpc/ren-ai.session-folders/inventory?${locationQuery}`, { input: {} })).output;
  assert.equal(inventory.length, 3);
  const shared = inventory.find((entry) => !entry.sandboxID);
  assert.deepEqual(shared?.relationships[coldID], before.relationship);
  assert.deepEqual(shared?.snapshot.runtime?.receipts, before.runtime?.receipts);
  assert.equal(shared?.bindings[coldID], undefined);
  assert(
    request("calls", undefined, 4710).includes('"observe"'),
    `Compiled turns must emit the application observe callback; native events: ${request("events", undefined, 4710)}`,
  );
  process.stdout.write(
    "Compiled OpenCode 2.0.19: shared persona RPC provisioning, bindings, updates, retained relationship scopes and isolated native/fork Sandboxes work; six standalone plugins load; memory/dice/context share one lock and isolate relationships; messaging tools, titles and Memory compaction work; no catalog fetch.\n",
  );
} catch (error) {
  if (probing)
    process.stderr.write(`Native execution events: ${request("events", undefined, 4710)}\n`);
  if (started) process.stderr.write(docker("logs", "--tail", "20", name));
  throw error;
} finally {
  for (const container of containers.toReversed()) {
    execFileSync("docker", ["rm", "--force", "--volumes", container], { stdio: "ignore" });
  }
  rmSync(root, { recursive: true, force: true });
}
