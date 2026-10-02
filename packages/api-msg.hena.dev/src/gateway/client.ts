import { Effect, Schema, Scope, Stream } from "effect";
import { rpcClient } from "../transport/rpc.ts";
import { messagingApi, tapback as tapbackSchema } from "./protocol.ts";
import type { IncomingMessage } from "../messages/messages.ts";

const failure = (error: string | Error) => new Error(String(error));

export const remoteMessages = (config: { readonly url: string; readonly token: string }) =>
  Effect.gen(function* () {
    const lifetime = yield* Scope.Scope;
    const client = yield* rpcClient(messagingApi, config);
    const probe = () => client.probe().pipe(Effect.mapError(failure));
    return {
      probe,
      image: (attachment: NonNullable<IncomingMessage["attachments"]>[number]) =>
        client.image({ reference: attachment.path }).pipe(Effect.mapError(failure)),
      sendText: (handle: string, text: string) =>
        client.sendText({ handle, text }).pipe(Effect.mapError(failure)),
      after: (rowID: number) => client.after({ rowID }).pipe(Effect.mapError(failure)),
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
      recent: (handle: string, since: number) =>
        client.recent({ handle, since }).pipe(Effect.mapError(failure)),
      status: (guid: string) => client.status({ guid }).pipe(Effect.mapError(failure)),
      sendStatus: (guid: string) => client.sendStatus({ guid }).pipe(Effect.mapError(failure)),
      textStatus: (handle: string, since: number) =>
        client.textStatus({ handle, since }).pipe(Effect.mapError(failure)),
      lastOutgoingStatus: (handle: string) =>
        client.lastOutgoingStatus({ handle }).pipe(Effect.mapError(failure)),
      gestures: {
        probe,
        typing: (handle: string, text: string, durationMillis: number) =>
          client.typing({ handle, text, durationMillis }).pipe(Effect.mapError(failure)),
        read: (handle: string) => client.read({ handle }).pipe(Effect.mapError(failure)),
        react: (handle: string, tapback: string) =>
          Schema.decodeUnknownEffect(tapbackSchema)(tapback).pipe(
            Effect.flatMap((value) => client.react({ handle, tapback: value })),
            Effect.mapError(failure),
          ),
      },
    };
  });
