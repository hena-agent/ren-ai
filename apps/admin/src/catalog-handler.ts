import { createHash, timingSafeEqual } from "node:crypto";
import { databaseStore } from "./database-store.ts";
import type { AdminEnv } from "./cloudflare-admin.ts";
import {
  loggedRequest,
  operation,
  reportFailure,
  requestId,
  writeLog as workerLog,
} from "./logging.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();

export function catalogHandler(request: Request, env: AdminEnv) {
  return loggedRequest(
    request,
    async () => {
      const pathname = new URL(request.url).pathname;
      if (request.method !== "GET")
        return new Response(null, { status: 405, headers: { Allow: "GET" } });
      const store = databaseStore(env.DB, env.IMAGES);
      try {
        if (pathname === "/api/personas")
          return Response.json(await operation("persona.publicList", {}, store.publicList), {
            headers: { "Cache-Control": "no-store" },
          });
        if (pathname.startsWith("/discovery/images/"))
          return await operation("image.publicRead", {}, () =>
            store.publicImage(pathname.slice("/discovery/images/".length)),
          );
        if (
          !env.CATALOG_TOKEN ||
          !timingSafeEqual(
            digest(request.headers.get("authorization") ?? ""),
            digest(`Bearer ${env.CATALOG_TOKEN}`),
          )
        )
          return new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } });
        return await operation("catalog.read", {}, async () => {
          const snapshot = await store.catalog();
          const revision = snapshot.revision;
          if (
            request.headers.get("if-none-match") ===
            `"${Buffer.from(revision).toString("base64url")}"`
          )
            return new Response(null, { status: 304 });
          return Response.json(snapshot, {
            headers: {
              "Cache-Control": "no-store",
              ETag: `"${Buffer.from(revision).toString("base64url")}"`,
            },
          });
        });
      } catch (cause) {
        reportFailure(cause, { stage: "catalog.request" });
        return Response.json(
          { error: "Catalog is unavailable", requestId: requestId() },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
    },
    workerLog,
  );
}
