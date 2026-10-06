// Loaded only by the isolated compiled-CLI regression container. No external traffic.
import { Schema } from "effect";
/** @type {Set<number>} */
const seen = new Set();
/** @type {number[]} */
const waits = [];
/** @type {string[]} */
const actions = [];
/** @type {object[]} */
const requests = [];
let catalogs = 0;
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
      "status",
      "sends",
      "alert",
      "wait",
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
  const match = /compiled-case:([0-9]+)/.exec(text);
  const index = Number(match?.[1] ?? -1);
  const inputs = [12000, 3600, 5.5, 3300, 0, -1, "120"];
  const tool = ["send", "read", "react"][index - inputs.length] ?? "wait";
  const input =
    index < inputs.length
      ? { seconds: inputs[index] }
      : tool === "send"
        ? { text: "isolated message" }
        : tool === "react"
          ? { tapback: "love" }
          : {};
  const waiting = body.tools?.some((entry) => entry.function.name === tool) && !seen.has(index);
  if (waiting) seen.add(index);
  const delta = text.includes("Write her Memory")
    ? {
        role: "assistant",
        content:
          "About him: isolated.\nThe two of them: isolated.\nPlans and promises: remember.\nLately: a compiled test.",
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

globalThis[Symbol.for("ren-ai.compiled-plugin.fixture")] ??= Bun.serve({
  hostname: "127.0.0.1",
  port: 4710,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/waits") return Response.json(waits);
    if (path === "/catalogs") return Response.json(catalogs);
    if (path === "/actions") return Response.json(actions);
    if (path === "/requests") return Response.json(requests);
    // BusyBox wget discards non-2xx bodies. Relay real native responses unchanged for assertions.
    if (path === "/native-http") return nativeHttp(request);
    if (path.includes("chat/completions")) return completion(request);
    /** @type {object[]} */
    const frames = [];
    for (const line of (await request.text()).trim().split("\n")) {
      const message = Schema.decodeUnknownSync(rpcRequest)(line);
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
        context: null,
        status: null,
        sends: [],
        alert: null,
        send: "isolated send completed",
        read: "isolated read completed",
        react: "isolated react completed",
      };
      if (message.tag === "wait") {
        if (typeof message.payload?.seconds !== "number")
          throw new Error("Missing numeric wait argument");
        waits.push(message.payload.seconds);
        frames.push({
          _tag: "Chunk",
          requestId: message.id,
          values: ["", `isolated wait completed: ${message.payload.seconds}`],
        });
      } else if (!(message.tag in values))
        throw new Error(`Forbidden isolated action: ${message.tag}`);
      if (["send", "read", "react"].includes(message.tag)) actions.push(message.tag);
      frames.push({
        _tag: "Exit",
        requestId: message.id,
        exit: {
          _tag: "Success",
          value: message.tag === "wait" ? null : values[message.tag],
        },
      });
    }
    return new Response(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
  },
});
