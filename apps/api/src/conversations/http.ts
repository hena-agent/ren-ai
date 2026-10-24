import { randomUUID } from "node:crypto";
import { Effect, Result, Schema } from "effect";
import { ConversationEnding, ConversationQuery, ConversationRecovery } from "@ren-ai/onboarding";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";
import type { conversationStatus } from "./status.ts";
import type { SqlClient } from "effect/unstable/sql";
import { operatorEnding } from "./operator-ending.ts";
import { RecoveryConflict } from "./recover.ts";
import type { usageQueries } from "../usage/query.ts";
import { conversationMessages } from "./messages.ts";

export const conversationMessagesRequest = (
  request: Request,
  messages: Parameters<typeof conversationMessages>[0],
  run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>,
) =>
  conversationRequest(request, async () => {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const url = new URL(request.url);
    const id = Number(url.searchParams.get("id"));
    const before = url.searchParams.has("before")
      ? Number(url.searchParams.get("before"))
      : undefined;
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      (before !== undefined && (!Number.isSafeInteger(before) || before <= 0))
    )
      return Response.json({ error: "invalid_query" }, { status: 400 });
    const result = await run(conversationMessages(messages, id, before));
    return Response.json(result ?? { error: "not_found" }, { status: result ? 200 : 404 });
  });

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

export const conversationRecords = (
  store: Effect.Success<ReturnType<typeof conversationStatus>>,
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  usage: Effect.Success<typeof usageQueries>,
) => {
  const readUsage = async (url: URL, id: number) => {
    const before = url.searchParams.has("before")
      ? Number(url.searchParams.get("before"))
      : undefined;
    if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0))
      return Response.json({ error: "invalid_cursor" }, { status: 400 });
    const result = await run(usage(id, before));
    return result ? Response.json(result) : Response.json({ error: "not_found" }, { status: 404 });
  };
  return (request: Request) =>
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
      const isUsage = url.pathname.endsWith("/usage");
      const id = Number(url.pathname.split("/").at(isUsage ? -2 : -1));
      if (!Number.isSafeInteger(id) || id <= 0)
        return Response.json({ error: "invalid_id" }, { status: 400 });
      if (isUsage) return readUsage(url, id);
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
};

export const requestOperatorEnding = (
  request: Request,
  run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>,
) =>
  conversationRequest(request, async (requestId) => {
    const match = /^\/management\/conversations\/(\d+)\/end$/.exec(new URL(request.url).pathname);
    if (!match) return new Response(null, { status: 405 });
    let input: typeof ConversationEnding.Type;
    try {
      input = Schema.decodeUnknownSync(ConversationEnding)(await request.json());
      if (input.id !== Number(match[1]))
        return Response.json({ error: "invalid_ending" }, { status: 400 });
    } catch {
      return Response.json({ error: "invalid_ending" }, { status: 400 });
    }
    const result = await run(operatorEnding(input).pipe(Effect.result));
    if (Result.isFailure(result)) {
      if (!(result.failure instanceof RecoveryConflict)) throw result.failure;
      contactLog({
        requestId,
        operation: "conversation.end",
        stage: "ending.commit",
        outcome: "failed",
        level: "warn",
        durationMs: 0,
        ...contactCause(result.failure),
      });
      return Response.json({ error: "ending_conflict" }, { status: 409 });
    }
    return Response.json({ queued: true }, { status: 202 });
  });
