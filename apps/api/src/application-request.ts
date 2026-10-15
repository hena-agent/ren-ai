import { randomUUID } from "node:crypto";
import { contactCause, contactLog } from "./discovery/diagnostics.ts";

export async function applicationRequest(
  request: Request,
  handle: (request: Request) => Promise<Response>,
) {
  const requestId = randomUUID();
  const start = performance.now();
  const fields = { requestId, operation: "api-app.request", stage: "request" };
  contactLog({ ...fields, outcome: "started", durationMs: 0, level: "info" });
  try {
    const headers = new Headers(request.headers);
    headers.set("X-Operation-ID", requestId);
    const response = await handle(new Request(request, { headers }));
    const child = response.headers.get("X-Request-ID");
    const operationId =
      child && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(child) ? child : requestId;
    response.headers.set("X-Request-ID", operationId);
    contactLog({
      ...fields,
      operationId,
      outcome: response.status >= 500 ? "failed" : "completed",
      durationMs: performance.now() - start,
      status: response.status,
      level: response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
    });
    return response;
  } catch (cause) {
    contactLog({
      ...fields,
      ...contactCause(cause),
      code: "application_unavailable",
      outcome: "failed",
      durationMs: performance.now() - start,
      status: 503,
      level: "error",
    });
    return Response.json(
      { error: "Application is unavailable", requestId },
      { status: 503, headers: { "X-Request-ID": requestId, "Cache-Control": "no-store" } },
    );
  }
}
