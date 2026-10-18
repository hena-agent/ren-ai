import { Effect, Layer, Option } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import { rpcRouter } from "@ren-ai/transport/server";
import type { MessagingTools } from "../application-tools.ts";
import type { FailureAlerts } from "./failed-turns.ts";
import { applicationApi } from "./application-protocol.ts";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";
import { HttpServerRequest } from "effect/unstable/http";

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
      Effect.gen(function* () {
        // RPC handlers receive the transport's request context at invocation, not layer creation.
        const request = Option.getOrThrow(
          yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest),
        );
        const requestId = request.headers["x-operation-id"] ?? crypto.randomUUID();
        const started = performance.now();
        yield* tools.observe(sessionID).pipe(
          Effect.catch((cause) => {
            contactLog({
              requestId,
              operation: "turn.observe",
              stage: "turn.schedule",
              outcome: "failed",
              level: "error",
              durationMs: performance.now() - started,
              ...contactCause(cause),
            });
            return Effect.fail(new Error(`Turn observation unavailable; request ${requestId}`));
          }),
        );
      }).pipe(action, Effect.mapError(String)),
    catalog: () => Effect.succeed([...tools.personas.values()]),
    send: ({ sessionID, text, callID }) =>
      tools.send(sessionID, text, callID).pipe(action, Effect.mapError(String)),
    endConversation: ({ sessionID, farewell, callID }) =>
      tools.endConversation(sessionID, farewell, callID).pipe(action, Effect.mapError(String)),
    read: ({ sessionID }) => tools.read(sessionID).pipe(action, Effect.mapError(String)),
    react: ({ sessionID, tapback, callID }) =>
      tools.react(sessionID, tapback, callID).pipe(action, Effect.mapError(String)),
    handle: ({ sessionID }) => tools.handleForSession(sessionID).pipe(Effect.mapError(String)),
    context: ({ sessionID, messageIDs }) =>
      tools.context(sessionID, messageIDs).pipe(Effect.mapError(String)),
    alert: ({ name, detail }) => alerts.raise(name, detail),
  });
  return rpcRouter(
    RpcServer.layerHttp({ group: applicationApi, path: "/rpc", protocol: "http" }).pipe(
      Layer.provide(handlers),
    ),
    token,
  );
};
