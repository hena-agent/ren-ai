import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { ConversationQuery, ConversationRecovery } from "@ren-ai/onboarding";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";
import type { conversationStatus } from "./status.ts";
import type { Effect } from "effect";

/** Shared diagnostic boundary for DB-only and executor-backed operator actions. */
export async function conversationRequest(
  request: Request,
  action: (requestId: string) => Promise<Response>,
) {
  const requestId = randomUUID();
  const started = performance.now();
  const parent = request.headers.get("x-operation-id");
  const operationId =
    parent && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(parent) ? parent : requestId;
  try {
    const response = await action(requestId);
    response.headers.set("X-Request-ID", requestId);
    response.headers.set("Cache-Control", "no-store");
    contactLog({
      requestId,
      operationId,
      operation: "conversation.management",
      stage: "request",
      outcome: "completed",
      level: response.status >= 400 ? "warn" : "info",
      status: response.status,
      durationMs: performance.now() - started,
    });
    return response;
  } catch (cause) {
    contactLog({
      requestId,
      operation: "conversation.management",
      stage: "request",
      outcome: "failed",
      level: "error",
      status: 503,
      durationMs: performance.now() - started,
      ...contactCause(cause),
    });
    return Response.json(
      { error: "conversation_unavailable", requestId },
      { status: 503, headers: { "X-Request-ID": requestId, "Cache-Control": "no-store" } },
    );
  }
}

export const conversationRecords =
  (
    store: Effect.Success<ReturnType<typeof conversationStatus>>,
    run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  ) =>
  (request: Request) =>
    conversationRequest(request, async () => {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const url = new URL(request.url);
      if (url.pathname === "/management/conversations") {
        let input: typeof ConversationQuery.Type;
        try {
          input = Schema.decodeUnknownSync(ConversationQuery)({
            filter: url.searchParams.get("filter") ?? "active",
            search: url.searchParams.get("search") ?? "",
            ...(url.searchParams.has("before") && {
              before: Number(url.searchParams.get("before")),
            }),
          });
        } catch {
          return Response.json({ error: "invalid_query" }, { status: 400 });
        }
        return Response.json(await run(store.list(input)));
      }
      const id = Number(url.pathname.split("/").at(-1));
      if (!Number.isSafeInteger(id) || id <= 0)
        return Response.json({ error: "invalid_id" }, { status: 400 });
      let cursor: string | undefined;
      try {
        cursor = Schema.decodeUnknownSync(
          Schema.UndefinedOr(ConversationRecovery.fields.requestId),
        )(url.searchParams.get("registrationsBefore") ?? undefined);
      } catch {
        return Response.json({ error: "invalid_cursor" }, { status: 400 });
      }
      const detail = await run(store.detail(id, cursor));
      return detail
        ? Response.json(detail)
        : Response.json({ error: "not_found" }, { status: 404 });
    });
