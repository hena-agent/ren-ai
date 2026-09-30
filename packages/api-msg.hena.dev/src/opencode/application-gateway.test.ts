import { Deferred, Effect, Fiber, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, test } from "vitest";
import { prepareMessaging } from "../application-tools.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { servePublic } from "../public-listener.ts";
import { rpcClient } from "../transport/rpc.ts";
import { applicationApi } from "./application-protocol.ts";
import { applicationGateway } from "./application-gateway.ts";
import { silentAlerts } from "./scripted-overrides.test-helper.ts";
import { registration, runMessagingTest } from "../../test/messaging-host.test-helper.ts";
import { listenerUrl } from "../../test/server.test-helper.ts";

test(
  "interrupting a remote wait cancels promptly without waiting for a heartbeat",
  () =>
    runMessagingTest(
      Effect.gen(function* () {
        const fake = fakeMessages();
        const prepared = yield* prepareMessaging(new Map(), fake.messages, fakeGestures().gestures);
        const conversation = yield* prepared.directory.create(
          registration("wait@example.com", "waiting"),
        );
        const web = applicationGateway(prepared.tools, silentAlerts, "secret");
        yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
        const requested = yield* Deferred.make<void>();
        const listener = yield* servePublic((request) => {
          Effect.runSync(Deferred.succeed(requested, undefined));
          return web.handler(request);
        }, 0);
        const client = yield* rpcClient(applicationApi, {
          url: `${listenerUrl(listener)}/rpc`,
          token: "secret",
        });
        const waiting = yield* client
          .wait({ sessionID: conversation.sessionID, minutes: 60 })
          .pipe(Stream.runDrain, Effect.forkScoped);
        yield* Deferred.await(requested);
        expect(waiting.pollUnsafe()).toBeUndefined();
        yield* Fiber.interrupt(waiting).pipe(Effect.timeout("2 seconds"));
        expect(fake.bubbles).toEqual([]);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  5000,
);
