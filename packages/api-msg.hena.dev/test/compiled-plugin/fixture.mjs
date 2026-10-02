// Loaded only by the isolated compiled-CLI regression container. No external traffic.
import { Schema } from "effect";
/** @type {Set<number>} */
const seen = new Set();
/** @type {number[]} */
const waits = [];
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
    tag: Schema.Literals(["catalog", "handle", "context", "status", "sends", "alert", "wait"]),
    payload: Schema.optional(
      Schema.NullOr(Schema.Struct({ minutes: Schema.optional(Schema.Number) })),
    ),
  }),
);
/** @param {Request} request */
async function completion(request) {
  const text = await request.text();
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
  const inputs = [200, 60, 30.5, 59, 0, -1, "120"];
  const waiting = body.tools?.some((tool) => tool.function.name === "wait") && !seen.has(index);
  if (waiting) seen.add(index);
  const delta = waiting
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `wait-case-${index}`,
            type: "function",
            function: { name: "wait", arguments: JSON.stringify({ minutes: inputs[index] }) },
          },
        ],
      }
    : { role: "assistant", content: "isolated case complete" };
  return new Response(
    `data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, waiting ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

Bun.serve({
  hostname: "127.0.0.1",
  port: 4710,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/waits") return Response.json(waits);
    if (path === "/catalogs") return Response.json(catalogs);
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
      };
      if (message.tag === "wait") {
        if (typeof message.payload?.minutes !== "number")
          throw new Error("Missing numeric wait argument");
        waits.push(message.payload.minutes);
        frames.push({
          _tag: "Chunk",
          requestId: message.id,
          values: ["", `isolated wait completed: ${message.payload.minutes}`],
        });
      } else if (!(message.tag in values))
        throw new Error(`Forbidden isolated action: ${message.tag}`);
      frames.push({
        _tag: "Exit",
        requestId: message.id,
        exit: { _tag: "Success", value: message.tag === "wait" ? null : values[message.tag] },
      });
    }
    return new Response(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
  },
});
