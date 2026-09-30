import { Effect, Layer, Stream } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import { rpcRouter } from "../transport/rpc.ts";
import type { MessagingTools } from "../application-tools.ts";
import type { FailureAlerts } from "./failed-turns.ts";
import { applicationApi } from "./application-protocol.ts";

export const applicationGateway = (
  tools: MessagingTools,
  alerts: FailureAlerts,
  token: string,
  actionsEnabled = true,
) => {
  const action = <A>(operation: Effect.Effect<A, Error>) =>
    actionsEnabled ? operation : Effect.fail(new Error("Application is in migration mode"));
  const handlers = applicationApi.toLayer({
    catalog: () => Effect.succeed([...tools.personas.values()]),
    send: ({ sessionID, text, callID }) =>
      tools.send(sessionID, text, callID).pipe(action, Effect.mapError(String)),
    wait: ({ sessionID, minutes }) =>
      Stream.fromEffect(action(tools.wait(sessionID, minutes))).pipe(
        Stream.merge(Stream.fromEffectRepeat(Effect.sleep("20 seconds").pipe(Effect.as(""))), {
          haltStrategy: "left",
        }),
        Stream.mapError(String),
        Stream.prepend([""]),
      ),
    read: ({ sessionID }) => tools.read(sessionID).pipe(action, Effect.mapError(String)),
    react: ({ sessionID, tapback, callID }) =>
      tools.react(sessionID, tapback, callID).pipe(action, Effect.mapError(String)),
    handle: ({ sessionID }) => tools.handleForSession(sessionID).pipe(Effect.mapError(String)),
    context: ({ sessionID }) => tools.onContext(sessionID).pipe(Effect.mapError(String)),
    status: ({ sessionID }) => tools.lastMessageStatus(sessionID).pipe(Effect.mapError(String)),
    sends: ({ sessionID }) => tools.settledSends(sessionID).pipe(Effect.mapError(String)),
    alert: ({ name, detail }) => alerts.raise(name, detail),
  });
  return rpcRouter(
    RpcServer.layerHttp({ group: applicationApi, path: "/rpc", protocol: "http" }).pipe(
      Layer.provide(handlers),
    ),
    token,
  );
};
