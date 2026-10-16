import { healthResponse } from "@ren-ai/transport/health";
import type { AdminEnv } from "./cloudflare-admin.ts";
import { loggedRequest, operation, validationFailure, writeLog } from "./logging.ts";

export async function adminHealth(request: Request, env: Pick<AdminEnv, "DB">) {
  return loggedRequest(
    request,
    async () => {
      if (request.method !== "GET")
        return new Response(null, {
          status: 405,
          headers: { Allow: "GET", "Cache-Control": "no-store" },
        });
      try {
        await operation("health.database", {}, async () => {
          try {
            return await env.DB.prepare("SELECT 1").first();
          } catch (cause) {
            throw validationFailure(
              "Database health unavailable",
              { code: "database_unavailable" },
              cause,
            );
          }
        });
        return healthResponse("admin", "ready", { database: "ready" });
      } catch {
        return healthResponse("admin", "degraded", { database: "unavailable" });
      }
    },
    writeLog,
  );
}
