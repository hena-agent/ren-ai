import { Effect, Schema, Scope, Stream } from "effect";
import { rpcClient } from "@ren-ai/transport/client";
import { messagingApi, tapback as tapbackSchema } from "./protocol.ts";
import type { IncomingMessage, Messages } from "../messages/messages.ts";
import { selectRecent } from "../messages/messages.ts";

const failure = (error: string | Error): Error & { requestId?: string } => {
  const result = new Error(String(error), { cause: error });
  const requestId = /request ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/.exec(
    result.message,
  )?.[1];
  return Object.assign(result, requestId ? { requestId } : {});
};
// Older Macs report unknown RPC tags as defects; expose an ordinary failure, never a send fallback.
const unavailable = (operation: string) =>
  Effect.catchDefect((cause) => Effect.fail(new Error(`${operation} RPC unavailable`, { cause })));
const notificationFailure = unavailable("Notification");
const sendFailure = unavailable("Identified send");
const request = <A, E extends string | Error, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout("30 seconds"), Effect.mapError(failure));

export const remoteMessages = (config: { readonly url: string; readonly token: string }) =>
  Effect.gen(function* () {
    const lifetime = yield* Scope.Scope;
    const client = yield* rpcClient(messagingApi, config);
    const probe = () => request(client.probe());
    return {
      probe,
      availability: (handle: string) =>
        request(client.availability({ handle }).pipe(unavailable("Availability"))),
      notify: (handle: string, text: string) =>
        request(client.notify({ handle, text }).pipe(notificationFailure)),
      notificationStatus: (guid: string) =>
        request(client.notificationStatus({ guid }).pipe(notificationFailure)),
      image: (attachment: NonNullable<IncomingMessage["attachments"]>[number]) =>
        request(client.image({ reference: attachment.path })),
      sendText: (handle: string, text: string, attemptID?: string) =>
        request(
          attemptID === undefined
            ? client.sendText({ handle, text })
            : client.submitText({ handle, text, attemptID }).pipe(sendFailure),
        ),
      resolveSend: (attemptID: string) =>
        request(
          client.resolveSend({ attemptID }).pipe(
            sendFailure,
            Effect.map((result) => result.state),
          ),
        ),
      after: (rowID: number, limit?: number) =>
        request(client.after({ rowID, ...(limit === undefined ? {} : { limit }) })),
      follow: (rowID: number, receive: (row: IncomingMessage) => Effect.Effect<void, Error>) => {
        let date: number | null = null;
        return Effect.map(
          Effect.forever(
            Effect.suspend(() =>
              Stream.runForEach(
                client.follow({ rowID, date }).pipe(Stream.filter((row) => row !== null)),
                (row) =>
                  receive(row).pipe(
                    Effect.tapError((error) =>
                      Effect.logWarning("Message processing failed; retrying", error.message),
                    ),
                    Effect.tap(() =>
                      Effect.sync(() => {
                        rowID = row.id;
                        date = row.createdAt;
                      }),
                    ),
                  ),
              ),
            ).pipe(
              Effect.catch(() => Effect.logWarning("Messaging stream ended; reconnecting")),
              Effect.andThen(Effect.sleep("1 second")),
            ),
          ).pipe(Effect.forkIn(lifetime)),
          (fiber) => () => fiber.interruptUnsafe(),
        );
      },
      recent: (handle: string, since: number, query: Parameters<Messages["recent"]>[2] = {}) =>
        request(client.recent({ handle, since, ...query })).pipe(
          Effect.map((rows) => selectRecent(rows, handle, since, query)),
        ),
      status: (guid: string) => request(client.status({ guid })),
      sendStatus: (guid: string) => request(client.sendStatus({ guid })),
      textStatus: (handle: string, since: number) => request(client.textStatus({ handle, since })),
      lastOutgoingStatus: (handle: string) => request(client.lastOutgoingStatus({ handle })),
      gestures: {
        probe,
        typing: (handle: string, text: string, durationMillis: number) =>
          request(client.typing({ handle, text, durationMillis })),
        read: (handle: string) => request(client.read({ handle })),
        react: (handle: string, tapback: string) =>
          request(
            Schema.decodeUnknownEffect(tapbackSchema)(tapback).pipe(
              Effect.flatMap((value) => client.react({ handle, tapback: value })),
            ),
          ),
      },
    };
  });
