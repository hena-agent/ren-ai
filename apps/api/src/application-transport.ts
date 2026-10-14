import { randomUUID } from "node:crypto";
import { contactCause, contactLog } from "./discovery/diagnostics.ts";

/** Initialization and DO transport fail outside the application's normal request boundary. */
export async function applicationTransport(request: Request, run: () => Promise<Response>) {
  const start = performance.now();
  try {
    return await run();
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
    return Response.json(
      { error: "Application is unavailable", requestId },
      { status: 503, headers: { "X-Request-ID": requestId, "Cache-Control": "no-store" } },
    );
  }
}
