import { Effect, Layer, Queue, Stream, Result } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import { authorize, rpcRouter } from "@ren-ai/transport/server";
import { healthResponse } from "@ren-ai/transport/health";
import type { IncomingMessage, Messages } from "../messages/messages.ts";
import type { Gestures } from "../gestures/gestures.ts";
import { messagingApi } from "./protocol.ts";
import { readAttachment, transportRow } from "./attachments.ts";

export const messageGateway = (messages: Messages, token: string, gestures: Gestures) => {
  const handlers = messagingApi.toLayer({
    probe: () => messages.after(0).pipe(Effect.andThen(gestures.probe()), Effect.mapError(String)),
    image: ({ reference }) => readAttachment(messages, reference).pipe(Effect.mapError(String)),
    sendText: ({ handle, text }) => messages.sendText(handle, text).pipe(Effect.mapError(String)),
    after: ({ rowID }) =>
      messages.after(rowID).pipe(
        Effect.map((rows) => rows.map(transportRow)),
        Effect.mapError(String),
      ),
    follow: ({ rowID, date }) =>
      Stream.callback<IncomingMessage, string>((queue) =>
        Effect.gen(function* () {
          const replaced =
            date !== null &&
            !(yield* messages.after(0)).some((row) => row.id === rowID && row.createdAt === date);
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
    recent: ({ handle, since }) =>
      messages.recent(handle, since).pipe(
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
    const result = await Effect.runPromise(
      messages
        .after(0)
        .pipe(Effect.andThen(gestures.probe()), Effect.timeout("3 seconds"), Effect.result),
    );
    if (Result.isFailure(result))
      process.stderr.write(
        `${JSON.stringify({
          service: "imsg",
          requestId,
          operation: "health",
          stage: "messages.probe",
          outcome: "failed",
          level: "error",
          durationMs: performance.now() - start,
          causeName: result.failure.name === "TimeoutError" ? "TimeoutError" : "Error",
          ...("code" in result.failure &&
            typeof result.failure.code === "string" &&
            /^[A-Z0-9_]{1,64}$/.test(result.failure.code) && { causeCode: result.failure.code }),
        })}\n`,
      );
    const response = healthResponse("imsg", Result.isSuccess(result) ? "ready" : "degraded");
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
