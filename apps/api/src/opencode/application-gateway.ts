import { Effect, Layer, Option } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import { rpcRouter } from "@ren-ai/transport/server";
import type { MessagingTools } from "../application-tools.ts";
import type { FailureAlerts } from "./failed-turns.ts";
import { applicationApi } from "./application-protocol.ts";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";
import { HttpServerRequest } from "effect/unstable/http";

const diagnosed = <A, R>(operation: string, stage: string, effect: Effect.Effect<A, Error, R>) =>
  Effect.gen(function* () {
    // RPC handlers receive the transport's request context at invocation, not layer creation.
    const request = Option.getOrThrow(
      yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest),
    );
    const requestId = request.headers["x-operation-id"] ?? crypto.randomUUID();
    const started = performance.now();
    return yield* effect.pipe(
      Effect.catch((cause) => {
        contactLog({
          requestId,
          operation,
          stage,
          outcome: "failed",
          level: "error",
          durationMs: performance.now() - started,
          ...contactCause(cause),
        });
        return Effect.fail(new Error(`Application callback unavailable; request ${requestId}`));
      }),
    );
  });

export const applicationGateway = (
  tools: MessagingTools,
  alerts: FailureAlerts,
  token: string,
  actionsEnabled = true,
) => {
  const action = <A, R>(operation: Effect.Effect<A, Error, R>) =>
    actionsEnabled ? operation : Effect.fail(new Error("Application is in migration mode"));
  const handlers = applicationApi.toLayer({
    observe: ({ sessionID }) =>
      diagnosed("turn.observe", "turn.schedule", tools.observe(sessionID)).pipe(
        action,
        Effect.mapError(String),
      ),
    catalog: () => Effect.succeed([...tools.personas.values()]),
    send: ({ sessionID, messages, callID }) =>
      tools.send(sessionID, messages, callID).pipe(action, Effect.mapError(String)),
    endConversation: ({ sessionID, farewell, callID }) =>
      tools.endConversation(sessionID, farewell, callID).pipe(action, Effect.mapError(String)),
    read: ({ sessionID }) => tools.read(sessionID).pipe(action, Effect.mapError(String)),
    react: ({ sessionID, tapback, callID }) =>
      tools.react(sessionID, tapback, callID).pipe(action, Effect.mapError(String)),
    handle: ({ sessionID }) => tools.handleForSession(sessionID).pipe(Effect.mapError(String)),
    context: ({ sessionID, messageIDs }) =>
      diagnosed("turn.context", "context.prepare", tools.context(sessionID, messageIDs)).pipe(
        Effect.mapError(String),
      ),
    alert: ({ name, detail }) => alerts.raise(name, detail),
  });
  return rpcRouter(
    RpcServer.layerHttp({ group: applicationApi, path: "/rpc", protocol: "http" }).pipe(
      Layer.provide(handlers),
    ),
    token,
  );
};
