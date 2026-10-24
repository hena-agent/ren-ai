import { Effect, Layer, Queue, Stream, Result } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import { authorize, rpcRouter } from "@ren-ai/transport/server";
import { healthResponse } from "@ren-ai/transport/health";
import type { IncomingMessage, Messages, Notifications } from "../messages/messages.ts";
import type { Gestures } from "../gestures/gestures.ts";
import { messagingApi } from "./protocol.ts";
import { readAttachment, transportRow } from "./attachments.ts";
import { notificationHandlers } from "./notifications.ts";
import { messageRequest } from "./operation.ts";

export const messageGateway = (
  messages: Messages,
  token: string,
  gestures: Gestures,
  notifications: Notifications,
) => {
  const handlers = messagingApi.toLayer({
    history: ({ handle, since, until, before }) =>
      messageRequest("messages.history", () =>
        messages
          .recent(handle, since, {
            ...(until !== null && { until }),
            ...(before !== undefined && { before }),
            reverse: true,
            limit: 51,
          })
          .pipe(
            Effect.flatMap((rows) =>
              Effect.forEach(rows, (row) =>
                Effect.map(
                  row.fromMe ? messages.status(row.guid) : Effect.succeed(null),
                  (status) => ({ ...transportRow(row), status }),
                ),
              ),
            ),
            Effect.map((entries) => ({ entries })),
          ),
      ),
    availability: ({ handle }) =>
      messageRequest("recipient.availability", (requestId) =>
        messages.availability(handle, requestId),
      ),
    ...notificationHandlers(notifications),
    probe: () =>
      messageRequest("messaging.probe", () =>
        messages.after(0, 1).pipe(Effect.andThen(gestures.probe()), Effect.as({})),
      ).pipe(Effect.asVoid),
    image: ({ reference }) => readAttachment(messages, reference).pipe(Effect.mapError(String)),
    sendText: ({ handle, text }) => messages.sendText(handle, text).pipe(Effect.mapError(String)),
    submitText: ({ handle, text, attemptID }) =>
      messageRequest("send.submit", (requestId) =>
        messages.sendText(handle, text, attemptID, requestId),
      ),
    resolveSend: ({ attemptID }) =>
      messageRequest("send.resolve", () =>
        messages.resolveSend(attemptID).pipe(Effect.map((state) => ({ state }))),
      ),
    after: ({ rowID, limit }) =>
      messages.after(rowID, limit).pipe(
        Effect.map((rows) => rows.map(transportRow)),
        Effect.mapError(String),
      ),
    follow: ({ rowID, date }) =>
      Stream.callback<IncomingMessage, string>((queue) =>
        Effect.gen(function* () {
          const replaced =
            date !== null &&
            !(yield* messages.after(Math.max(0, rowID - 1), 1)).some(
              (row) => row.id === rowID && row.createdAt === date,
            );
          yield* Effect.acquireRelease(
            messages.follow(replaced ? 0 : rowID, (row) =>
              replaced && row.createdAt < date
                ? Effect.void
                : Queue.offer(queue, transportRow(row)).pipe(Effect.asVoid),
            ),
            (stop) => Effect.sync(stop),
          );
        }).pipe(Effect.mapError(String)),
      ).pipe(
        Stream.merge(Stream.fromEffectRepeat(Effect.sleep("20 seconds").pipe(Effect.as(null)))),
        // Flush headers even when Messages is idle, so cancellation can close the request.
        Stream.prepend([null]),
      ),
    recent: ({ handle, since, ...query }) =>
      messages.recent(handle, since, query).pipe(
        Effect.map((rows) => rows.map(transportRow)),
        Effect.mapError(String),
      ),
    status: ({ guid }) => messages.status(guid).pipe(Effect.mapError(String)),
    sendStatus: ({ guid }) => messages.sendStatus(guid).pipe(Effect.mapError(String)),
    textStatus: ({ handle, since }) =>
      messages.textStatus(handle, since).pipe(Effect.mapError(String)),
    lastOutgoingStatus: ({ handle }) =>
      messages.lastOutgoingStatus(handle).pipe(Effect.mapError(String)),
    typing: ({ handle, text, durationMillis }) =>
      gestures.typing(handle, text, durationMillis).pipe(Effect.mapError(String)),
    read: ({ handle }) => gestures.read(handle).pipe(Effect.mapError(String)),
    react: ({ handle, tapback }) => gestures.react(handle, tapback).pipe(Effect.mapError(String)),
  });
  const rpc = rpcRouter(
    RpcServer.layerHttp({ group: messagingApi, path: "/rpc", protocol: "http" }).pipe(
      Layer.provide(handlers),
    ),
    token,
  );
  const authorizedHealth = authorize(async (request) => {
    if (request.method !== "GET") {
      const requestId = crypto.randomUUID();
      process.stderr.write(
        `${JSON.stringify({
          service: "imsg",
          requestId,
          operation: "health",
          stage: "routing",
          outcome: "rejected",
          level: "warn",
          status: 405,
        })}\n`,
      );
      return new Response(null, {
        status: 405,
        headers: {
          Allow: "GET",
          "Cache-Control": "no-store",
          "X-Request-ID": requestId,
        },
      });
    }
    const requestId = crypto.randomUUID();
    const start = performance.now();
    const [result, notificationResult] = await Effect.runPromise(
      Effect.all(
        [
          messages
            .after(0, 1)
            .pipe(Effect.andThen(gestures.probe()), Effect.timeout("3 seconds"), Effect.result),
          notifications.probe().pipe(Effect.timeout("3 seconds"), Effect.result),
        ],
        { concurrency: "unbounded" },
      ),
    );
    for (const [stage, checked] of [
      ["messages.probe", result],
      ["notifications.probe", notificationResult],
    ] as const) {
      if (Result.isFailure(checked))
        process.stderr.write(
          `${JSON.stringify({
            service: "imsg",
            requestId,
            operation: "health",
            stage,
            outcome: "failed",
            level:
              "code" in checked.failure && checked.failure.code === "HANDLE_NOT_REGISTERED"
                ? "warn"
                : "error",
            durationMs: performance.now() - start,
            causeName: checked.failure.name === "TimeoutError" ? "TimeoutError" : "Error",
            ...("code" in checked.failure &&
              typeof checked.failure.code === "string" &&
              /^[A-Z0-9_]{1,64}$/.test(checked.failure.code) && {
                causeCode: checked.failure.code,
              }),
          })}\n`,
        );
    }
    const status = Result.isSuccess(result) ? "ready" : "degraded";
    // Notifications are optional until Discovery's separately deployed join flow uses them.
    const response = healthResponse("imsg", status, {
      dependencies: {
        messages: status,
        notifications: Result.isSuccess(notificationResult) ? "ready" : "degraded",
      },
    });
    response.headers.set("X-Request-ID", requestId);
    return response;
  }, token);
  const health = async (request: Request) => {
    const response = await authorizedHealth(request);
    response.headers.set("Cache-Control", "no-store");
    if (response.headers.has("X-Request-ID")) return response;
    const requestId = crypto.randomUUID();
    response.headers.set("X-Request-ID", requestId);
    process.stderr.write(
      `${JSON.stringify({
        service: "imsg",
        requestId,
        operation: "health",
        stage: "authorization",
        outcome: "rejected",
        level: "warn",
        status: response.status,
      })}\n`,
    );
    return response;
  };
  return {
    dispose: rpc.dispose,
    handler: (request: Request) =>
      new URL(request.url).pathname === "/health" ? health(request) : rpc.handler(request),
  };
};
