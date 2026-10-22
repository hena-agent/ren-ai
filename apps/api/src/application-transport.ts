import { randomUUID } from "node:crypto";
import { contactCause, contactLog } from "./discovery/diagnostics.ts";
import { healthResponse } from "@ren-ai/transport/health";
import { buildRevision } from "@ren-ai/transport/health";
import { Schema } from "effect";

const ExecutorHealth = Schema.Struct({
  status: Schema.Literals([
    "ready",
    "degraded",
    "unauthorized",
    "unexpected_response",
    "unreachable",
    "unconfigured",
  ]),
  service: Schema.optionalKey(Schema.String),
  revision: Schema.optionalKey(Schema.String),
});
const ApplicationHealth = Schema.Struct({
  service: Schema.Literal("api-app"),
  revision: Schema.String,
  status: Schema.Literals(["ready", "degraded"]),
  database: Schema.Literals(["ready", "unavailable"]),
  storage: Schema.Literal("durable-object-sqlite"),
  bootstrapOnly: Schema.Boolean,
  executor: ExecutorHealth,
  messaging: Schema.optionalKey(Schema.Literals(["ready", "unavailable"])),
});

async function workerHealth(response: Response) {
  try {
    const health = Schema.decodeUnknownSync(ApplicationHealth)(await response.json());
    const current = health.revision === buildRevision();
    const result = healthResponse(
      "api-app",
      health.status === "ready" && health.messaging === "ready" && current ? "ready" : "degraded",
      {
        database: health.database,
        storage: health.storage,
        bootstrapOnly: health.bootstrapOnly,
        executor: health.executor,
        messaging: health.messaging ?? "unavailable",
        applicationRuntime: { revision: health.revision, status: current ? "ready" : "outdated" },
      },
    );
    return result;
  } catch {
    return healthResponse("api-app", "degraded", { applicationRuntime: { status: "unavailable" } });
  }
}

/** Initialization and DO transport fail outside the application's normal request boundary. */
export async function applicationTransport(request: Request, run: () => Promise<Response>) {
  const start = performance.now();
  try {
    const response = await run();
    if (new URL(request.url).pathname !== "/health" || request.method !== "GET") return response;
    const health = await workerHealth(response);
    const requestId = response.headers.get("x-request-id");
    if (requestId) health.headers.set("x-request-id", requestId);
    return health;
  } catch (cause) {
    const requestId = randomUUID();
    contactLog({
      requestId,
      operation: `api-app.${request.method}.transport`,
      stage: "application.runtime",
      outcome: "failed",
      durationMs: performance.now() - start,
      level: "error",
      status: 503,
      ...contactCause(cause),
    });
    if (new URL(request.url).pathname === "/health") {
      const response = healthResponse("api-app", "degraded", {
        application: "unavailable",
        requestId,
      });
      response.headers.set("X-Request-ID", requestId);
      return response;
    }
    return Response.json(
      { error: "Application is unavailable", requestId },
      { status: 503, headers: { "X-Request-ID": requestId, "Cache-Control": "no-store" } },
    );
  }
}
