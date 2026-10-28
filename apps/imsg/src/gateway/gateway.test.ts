import { Deferred, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { expect, test } from "vitest";
import { fakeMessages } from "../messages/messages.fake.ts";
import type { IncomingMessage } from "../messages/messages.ts";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { fakeNotifications } from "../messages/notifications.fake.ts";
import { messageGateway } from "./server.ts";
import { remoteMessages } from "./client.ts";
import { gatewayFixture } from "../../test/gateway.test-helper.ts";

test("the public messaging API authorizes a send before touching Messages", async () => {
  const local = fakeMessages();
  const gestures = fakeGestures();
  const server = messageGateway(
    local.messages,
    "gateway-secret",
    gestures.gestures,
    fakeNotifications(),
  );
  try {
    const denied = await server.handler(new Request("https://imsg.test/rpc", { method: "POST" }));
    expect(denied.status).toBe(401);
    expect(local.bubbles).toEqual([]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const remote = yield* remoteMessages({
            url: "https://imsg.test/rpc",
            token: "gateway-secret",
          });
          yield* remote.probe();
          expect(yield* remote.sendText("+821012345678", "hello")).toEqual({ guid: "fake-1" });
          expect(local.bubbles).toEqual([{ handle: "+821012345678", text: "hello" }]);
          expect(yield* remote.status("fake-1")).toEqual({
            state: "sent",
            error: 0,
            dateRead: null,
          });
          expect(yield* remote.sendStatus("missing")).toBe("unknown");
          expect(yield* remote.textStatus("+821012345678", 0)).toBe("sent");
          expect(yield* remote.lastOutgoingStatus("+821012345678")).toEqual({
            delivered: false,
            readAt: null,
          });
          expect(yield* remote.lastOutgoingStatus("absent")).toBeUndefined();
          const incoming = yield* local.text("+821012345678", "reply", 100);
          expect(yield* remote.after(1)).toEqual([incoming]);
          expect(yield* remote.recent("+821012345678", 100)).toContainEqual(incoming);
          expect(
            yield* remote.recent("+821012345678", 0, { guid: incoming.guid, limit: 1 }),
          ).toEqual([incoming]);
          expect(
            yield* remote.recent("+821012345678", 0, { after: incoming.id, limit: 1 }),
          ).toEqual([]);
          expect(yield* remote.recent("+821012345678", 0, { reverse: true, limit: 1 })).toEqual([
            incoming,
          ]);
          const history = yield* remote.history({ handle: incoming.handle, since: 0, until: null });
          expect(history.map((row) => [row.text, row.status?.state ?? null])).toEqual([
            ["reply", null],
            ["hello", "sent"],
          ]);
          expect(
            yield* remote.history({
              handle: incoming.handle,
              since: 0,
              until: 101,
              before: incoming.id,
            }),
          ).toHaveLength(0);
          expect(yield* remote.gestures.typing("+821012345678", "next", 1000)).toBe(true);
          yield* remote.gestures.read("+821012345678");
          yield* remote.gestures.react("+821012345678", "love");
          expect(gestures.typing).toEqual([{ handle: "+821012345678", durationMillis: 1000 }]);
          expect(gestures.reads).toEqual(["+821012345678"]);
          expect(gestures.reactions).toEqual([{ handle: "+821012345678", tapback: "love" }]);
          const next = yield* Deferred.make<IncomingMessage>();
          const stop = yield* remote.follow(incoming.id, (row) =>
            Deferred.succeed(next, row).pipe(Effect.asVoid),
          );
          const fresh = yield* local.text("+821012345678", "live", 200);
          expect(yield* Deferred.await(next).pipe(Effect.timeout("3 seconds"))).toEqual(fresh);
          stop();
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
          server.handler(new Request(input, init)),
        ),
      ),
    );
  } finally {
    await server.dispose();
  }
});

test("history selectors also consume a deployed Mac's complete unbounded response correctly", async () => {
  const f = gatewayFixture();
  const recent = f.local.messages.recent.bind(f.local.messages);
  f.local.messages.recent = (handle, since) => recent(handle, since);
  try {
    await f.run((remote) =>
      Effect.gen(function* () {
        const first = yield* f.local.text("user@example.test", "first", 1);
        const second = yield* f.local.text("user@example.test", "second", 2);
        expect(yield* remote.recent(first.handle, 0, { guid: first.guid, limit: 1 })).toEqual([
          first,
        ]);
        expect(yield* remote.recent(first.handle, 0, { after: first.id, limit: 1 })).toEqual([
          second,
        ]);
        expect(yield* remote.recent(first.handle, 0, { reverse: true, limit: 1 })).toEqual([
          second,
        ]);
        expect(yield* remote.recent(first.handle, 0, { guid: "missing" })).toEqual([]);
      }),
    );
  } finally {
    await f.server.dispose();
  }
});
