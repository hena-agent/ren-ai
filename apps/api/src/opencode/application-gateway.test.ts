import { Deferred, Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, test, vi } from "vitest";
import { prepareMessaging } from "../application-tools.ts";
import { fakeMessages, fakeGestures } from "@ren-ai/imsg/testing";
import { servePublic } from "@ren-ai/transport/listener";
import { rpcClient } from "@ren-ai/transport/client";
import { applicationApi } from "./application-protocol.ts";
import { applicationGateway } from "./application-gateway.ts";
import { registration, runMessagingTest, silentAlerts } from "../../test/messaging.test-helper.ts";
import { listenerUrl } from "../../test/listener.test-helper.ts";
import { applicationRequest } from "../application-request.ts";

test(
  "context responses finish without a keep-alive stream",
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
        const context = yield* client
          .context({ sessionID: conversation.sessionID, messageIDs: [] })
          .pipe(Effect.timeout("2 seconds"));
        yield* Deferred.await(requested);
        expect(context).toEqual({ status: undefined, sends: [] });
        expect(fake.bubbles).toEqual([]);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  5000,
);

test.each([
  ["observe", "turn.schedule"],
  ["context", "context.prepare"],
] as const)(
  "%s failures keep their cause in correlated diagnostics and return a safe request ID",
  (operation, stage) =>
    runMessagingTest(
      Effect.gen(function* () {
        const prepared = yield* prepareMessaging(
          new Map(),
          fakeMessages().messages,
          fakeGestures().gestures,
        );
        const cause = new Error("private SQL payload", {
          cause: Object.assign(new Error("private cause"), { code: "SQLITE_BUSY" }),
        });
        const web = applicationGateway(
          { ...prepared.tools, [operation]: () => Effect.fail(cause) },
          silentAlerts,
          "secret",
        );
        yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
        const logs: string[] = [];
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
          logs.push(String(chunk));
          return true;
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => stderr.mockRestore()));
        let responseId: string | null = null;
        const client = yield* rpcClient(applicationApi, {
          url: "https://app/rpc",
          token: "secret",
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
            const response = await applicationRequest(new Request(input, init), web.handler);
            responseId = response.headers.get("X-Request-ID");
            return response;
          }),
        );
        const failure = yield* client[operation](
          { sessionID: "private-session", messageIDs: ["private-message"] },
          {
            headers: { "x-operation-id": "private-forged-request-id" },
          },
        ).pipe(Effect.flip);
        if (typeof failure !== "string") throw failure;
        expect(logs).toHaveLength(1);
        const requestId = failure.match(/[0-9a-f-]{36}/)?.[0];
        expect(requestId).toBeDefined();
        expect(requestId).toBe(responseId);
        expect(logs[0]).toContain(requestId);
        expect(logs[0]).toContain('"causeCode":"SQLITE_BUSY"');
        expect(logs[0]).toContain(`"stage":"${stage}"`);
        expect(logs[0]).toContain(`"operation":"turn.${operation}"`);
        expect(logs[0]).toContain('"stack":');
        expect(logs.join("") + failure).not.toMatch(
          /private SQL|private cause|private-session|private-message|private-forged|secret/,
        );
      }),
    ),
);
