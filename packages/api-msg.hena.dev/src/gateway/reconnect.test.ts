import { Deferred, Effect, Logger, Schema } from "effect";
import { expect, test } from "vitest";
import { gatewayFixture } from "../../test/gateway.test-helper.ts";
import type { IncomingMessage } from "../messages/messages.ts";

test.each(["transport", "processing"])(
  "a %s failure replays pending messages and reports its source",
  async (source) => {
    const fixture = gatewayFixture();
    const logs: string[] = [];
    let follows = 0;
    fixture.transport.fetch = async (request) => {
      if (
        (await request.clone().text()).includes('"tag":"follow"') &&
        ++follows === 1 &&
        source === "transport"
      )
        return new Response("temporarily offline", { status: 503 });
      return fixture.server.handler(request);
    };
    try {
      await fixture.run((remote) =>
        Effect.gen(function* () {
          const received = yield* Deferred.make<IncomingMessage>();
          let first = true;
          const stop = yield* remote.follow(0, (row) =>
            Effect.gen(function* () {
              if (source === "processing" && first) {
                first = false;
                yield* Effect.fail(new Error("inbox cancellation unavailable"));
              }
              yield* Deferred.succeed(received, row);
            }),
          );
          const pending = yield* fixture.local.text("+821012345678", "during outage", 200);
          expect(yield* Deferred.await(received).pipe(Effect.timeout("4 seconds"))).toEqual(
            pending,
          );
          expect(follows).toBe(2);
          stop();
        }).pipe(
          Effect.withLogger(
            Logger.make<ReadonlyArray<string>, void>(({ message }) => {
              logs.push(...message);
            }),
          ),
        ),
      );
      expect(logs).toContain("Messaging stream ended; reconnecting");
      expect(logs.includes("Message processing failed; retrying")).toBe(source === "processing");
      expect(logs.includes("inbox cancellation unavailable")).toBe(source === "processing");
    } finally {
      await fixture.server.dispose();
    }
  },
);

test.each([false, true])(
  "reconnect preserves the checkpoint and rebases a replacement Mac (replaced: %s)",
  async (replaced) => {
    const fixture = gatewayFixture();
    let disconnect = true;
    fixture.transport.fetch = async (request) => {
      const watching = (await request.clone().text()).includes('"tag":"follow"');
      const response = await fixture.server.handler(request);
      if (!watching || !disconnect) return response;
      disconnect = false;
      const reader = response.body!.getReader();
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (;;) {
              const chunk = await reader.read();
              const bytes = Schema.decodeUnknownSync(Schema.Uint8Array)(chunk.value);
              controller.enqueue(bytes);
              if (new TextDecoder().decode(bytes).includes('"guid":"before"')) break;
            }
            controller.close();
            await reader.cancel();
          },
        }),
        { headers: response.headers },
      );
    };
    try {
      await fixture.run((remote) =>
        Effect.gen(function* () {
          const original = {
            id: 40,
            guid: "before",
            handle: "+821012345678",
            text: "before",
            createdAt: 100,
            fromMe: false,
          };
          const fresh = {
            ...original,
            id: replaced ? 1 : 41,
            guid: "after",
            text: "after",
            createdAt: 100,
          };
          yield* fixture.local.replace([original]);
          const received = yield* Deferred.make<IncomingMessage>();
          const seen: string[] = [];
          const stop = yield* remote.follow(0, (row) =>
            Effect.gen(function* () {
              seen.push(row.guid);
              if (row.guid === "before") {
                yield* fixture.local.replace(
                  replaced
                    ? [fresh, { ...original, guid: "older", createdAt: 99 }]
                    : [original, fresh],
                );
              } else yield* Deferred.succeed(received, row);
            }),
          );
          expect(yield* Deferred.await(received).pipe(Effect.timeout("4 seconds"))).toEqual(fresh);
          yield* Effect.sleep("10 millis");
          expect(seen).toEqual(["before", "after"]);
          stop();
        }),
      );
    } finally {
      await fixture.server.dispose();
    }
  },
);
