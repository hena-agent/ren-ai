import { Effect, Layer, Queue, Stream } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import { rpcRouter } from "../transport/rpc.ts";
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
  return rpcRouter(
    RpcServer.layerHttp({ group: messagingApi, path: "/rpc", protocol: "http" }).pipe(
      Layer.provide(handlers),
    ),
    token,
  );
};
