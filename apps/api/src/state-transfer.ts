import { createHash, timingSafeEqual } from "node:crypto";
import {
  exportApplicationState,
  importApplicationState,
  readStateSnapshot,
} from "./state-snapshot.ts";
import type { ApplicationStore } from "./application-store.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();

export async function stateTransfer(
  request: Request,
  store: ApplicationStore,
  token: string,
  bootstrapOnly: boolean,
) {
  if (
    !timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${token}`))
  )
    return new Response("Unauthorized", { status: 401 });
  if (!bootstrapOnly)
    return Response.json({ error: "State transfer requires bootstrap mode" }, { status: 409 });
  const path = new URL(request.url).pathname;
  if (path === "/management/state/export" && request.method === "GET")
    return Response.json(await store.run(exportApplicationState), {
      headers: { "Cache-Control": "no-store" },
    });
  if (path !== "/management/state/import" || request.method !== "POST")
    return new Response(null, { status: 405 });
  const snapshot = readStateSnapshot(await request.json());
  return Response.json(await store.run(importApplicationState(snapshot)), {
    headers: { "Cache-Control": "no-store" },
  });
}
