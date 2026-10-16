import { healthResponse } from "@ren-ai/transport/health";
import type { AdminEnv } from "./cloudflare-admin.ts";
import { loggedRequest, operation, validationFailure, writeLog } from "./logging.ts";

async function readiness(stage: string, check: () => Promise<void>) {
  try {
    await operation(stage, {}, async () => {
      try {
        await check();
      } catch (cause) {
        throw validationFailure(
          "Admin dependency unavailable",
          { code: "dependency_unavailable" },
          cause,
        );
      }
    });
    return "ready" as const;
  } catch {
    return "unavailable" as const;
  }
}

export async function adminHealth(
  request: Request,
  env: Pick<AdminEnv, "DB">,
  editor: () => Promise<Response>,
) {
  return loggedRequest(
    request,
    async () => {
      if (request.method !== "GET")
        return new Response(null, {
          status: 405,
          headers: { Allow: "GET", "Cache-Control": "no-store" },
        });
      const [database, editing] = await Promise.all([
        readiness("health.database", async () => {
          await env.DB.prepare("SELECT 1").first();
        }),
        readiness("health.editor", async () => {
          const response = await editor();
          if (!response.ok) throw new Error("Editor readiness check failed");
        }),
      ]);
      return healthResponse(
        "admin",
        database === "ready" && editing === "ready" ? "ready" : "degraded",
        { database, editor: editing },
      );
    },
    writeLog,
  );
}
