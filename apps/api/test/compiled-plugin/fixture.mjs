// Loaded only by the isolated compiled-CLI regression container. No external traffic.
import { Schema } from "effect";
/** @type {Set<number>} */
const seen = new Set();
/** @type {string[]} */
const calls = [];
/** @type {string[]} */
const actions = [];
/** @type {object[]} */
const requests = [];
let catalogs = 0;
/** @type {{ type: string, directory?: string }[]} */
const events = [];
let observing = false;
async function observeEvents() {
  const response = await fetch("http://127.0.0.1:4096/api/event", {
    headers: { authorization: `Basic ${btoa("opencode:isolated-regression-password")}` },
  });
  if (!response.body) throw new Error("Missing native event stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return;
    if (!(chunk.value instanceof Uint8Array)) throw new Error("Invalid native event stream chunk");
    pending += decoder.decode(chunk.value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const event = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            type: Schema.String,
            location: Schema.optionalKey(Schema.Struct({ directory: Schema.String })),
          }),
        ),
      )(line.slice(6));
      if (event.type.startsWith("session.execution."))
        events.push({
          type: event.type,
          ...(event.location && { directory: event.location.directory }),
        });
    }
  }
}
let release = () => {};
let held = false;
const lockKey = Symbol.for("ren-ai.persona-memory.locks");
const fixtureKey = Symbol.for("ren-ai.compiled-plugin.fixture");
/** @type {typeof globalThis & { [lockKey]?: Map<string, Promise<void>>, [fixtureKey]?: ReturnType<typeof Bun.serve> }} */
const processState = globalThis;
const locks = (processState[lockKey] ??= new Map());
const personaDirectory = "/srv/ren-ai/personas/persona1";
/** @type {Promise<void> | undefined} */
let gate;
const sharedCalls = [
  {
    name: "update_state",
    arguments: {
      scores: { mood: 67, energy: 68, stress: 31, connection: 62, solitude: 42 },
      additions: {},
      remove: [],
      reason: "A quiet afternoon",
    },
  },
  {
    name: "update_memory",
    arguments: {
      scope: "life",
      markdown: "Shared afternoon at the pottery studio.",
      reason: "My afternoon plans",
    },
  },
  {
    name: "update_memory",
    arguments: {
      scope: "relationship",
      markdown: "Private violet promise with this user.",
      reason: "Our own agreement",
    },
  },
  { name: "dice", arguments: {} },
];
let sharedStarted = false;
/** @param {object} delta @param {string | null} finish_reason */
const chunk = (delta, finish_reason) => ({
  id: "isolated-probe",
  object: "chat.completion.chunk",
  created: 1,
  model: "probe",
  choices: [{ index: 0, delta, finish_reason }],
});
const rpcRequest = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Number,
    tag: Schema.Literals([
      "catalog",
      "handle",
      "context",
      "alert",
      "observe",
      "send",
      "read",
      "react",
    ]),
    payload: Schema.optional(
      Schema.NullOr(Schema.Struct({ seconds: Schema.optional(Schema.Number) })),
    ),
  }),
);
/** @param {Request} request */
async function completion(request) {
  if (!observing) {
    observing = true;
    void observeEvents().catch(() => events.push({ type: "capture_failed" }));
  }
  const text = await request.text();
  requests.push(
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
      text,
    ),
  );
  const body = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        tools: Schema.optional(
          Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
        ),
      }),
    ),
  )(text);
  if (text.includes("compiled-shared:writer") && !sharedStarted) {
    sharedStarted = true;
    held = true;
    gate = new Promise((resolve) => {
      release = () => {
        held = false;
        resolve();
      };
    });
    locks.set(personaDirectory, gate);
    const delta = {
      role: "assistant",
      tool_calls: sharedCalls.map((call, index) => ({
        index,
        id: `shared-case-${index}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
    return new Response(
      `data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, "tool_calls"))}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  const match = /compiled-case:([0-9]+)/.exec(text);
  const index = Number(match?.[1] ?? -1);
  const inputs = [12000, 3600, 5.5, 3300, 0, -1, "120"];
  const tool = ["send", "read", "react"][index - inputs.length] ?? "wait";
  const input =
    index < inputs.length
      ? { seconds: inputs[index] }
      : tool === "send"
        ? { messages: [{ text: "isolated message" }] }
        : tool === "react"
          ? { tapback: "love" }
          : {};
  const waiting =
    index >= 0 && body.tools?.some((entry) => entry.function.name === tool) && !seen.has(index);
  if (waiting) seen.add(index);
  const delta = text.includes("Write her Memory")
    ? {
        role: "assistant",
        content:
          "## Important Context\nAbout him: isolated.\nThe two of them: isolated.\nPlans and promises: remember.\nLately: a compiled test.",
      }
    : waiting
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `wait-case-${index}`,
              type: "function",
              function: { name: tool, arguments: JSON.stringify(input) },
            },
          ],
        }
      : { role: "assistant", content: "isolated case complete" };
  return new Response(
    `data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, waiting ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** @param {Request} request */
async function nativeHttp(request) {
  const input = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        path: Schema.String.check(Schema.isPattern(/^\/api\//)),
        method: Schema.Literals(["POST", "DELETE"]),
        body: Schema.optional(Schema.String),
      }),
    ),
  )(await request.text());
  const response = await fetch(`http://127.0.0.1:4096${input.path}`, {
    method: input.method,
    headers: {
      authorization: `Basic ${btoa("opencode:isolated-regression-password")}`,
      "x-opencode-directory": "/srv/ren-ai",
      "content-type": "application/json",
    },
    ...(input.body === undefined ? {} : { body: input.body }),
  });
  return Response.json({ status: response.status, body: await response.text() });
}

processState[fixtureKey] ??= Bun.serve({
  hostname: "127.0.0.1",
  port: 4710,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/calls") return Response.json(calls);
    if (path === "/catalogs") return Response.json(catalogs);
    if (path === "/actions") return Response.json(actions);
    if (path === "/requests") return Response.json(requests);
    if (path === "/events") return Response.json(events);
    if (path === "/gate")
      return Response.json({ held, queued: held && locks.get(personaDirectory) !== gate });
    if (path === "/release") {
      release();
      return Response.json(null);
    }
    // BusyBox wget discards non-2xx bodies. Relay real native responses unchanged for assertions.
    if (path === "/native-http") return nativeHttp(request);
    if (path.includes("chat/completions")) return completion(request);
    /** @type {object[]} */
    const frames = [];
    for (const line of (await request.text()).trim().split("\n")) {
      const message = Schema.decodeUnknownSync(rpcRequest)(line);
      calls.push(message.tag);
      if (message.tag === "catalog" && ++catalogs === 1)
        return new Response("Starting", { status: 503 });
      const values = {
        catalog: [
          {
            id: "persona1",
            timeZone: "UTC",
            language: "en",
            openingLine: "Hello",
            memory: "Remember.",
            prompt: "Isolated test persona.",
          },
        ],
        handle: "isolated@example.com",
        context: { status: null, sends: [] },
        observe: null,
        alert: null,
        send: "isolated send completed",
        read: "isolated read completed",
        react: "isolated react completed",
      };
      if (!(message.tag in values)) throw new Error(`Forbidden isolated action: ${message.tag}`);
      if (["send", "read", "react"].includes(message.tag)) actions.push(message.tag);
      frames.push({
        _tag: "Exit",
        requestId: message.id,
        exit: {
          _tag: "Success",
          value: values[message.tag],
        },
      });
    }
    return new Response(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
  },
});
