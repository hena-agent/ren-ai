import { loggedRequest, reportFailure, requestId, validationFailure, writeLog } from "./logging.ts";

/** Initialization and Durable Object transport errors occur outside the editor handler. */
export async function adminRequest(request: Request, run: () => Promise<Response>) {
  const start = performance.now();
  try {
    return await run();
  } catch (cause) {
    return loggedRequest(
      request,
      async () => {
        reportFailure(
          validationFailure("Admin runtime is unavailable", { code: "runtime_unavailable" }, cause),
          { stage: "admin.runtime", durationMs: performance.now() - start },
        );
        return Response.json(
          { error: "Admin is unavailable", requestId: requestId() },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      },
      writeLog,
    );
  }
}
