import { Context, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect, test } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import {
  fakeGestures,
  fakeMessages,
  fakeNotifications,
  messageGateway,
} from "@ren-ai/imsg/testing";
import { createExecutionRuntime } from "./execution-runtime.ts";
import { cloudflareConfiguration } from "./cloudflare-config.ts";
import type { ApplicationStore } from "./application-store.ts";
import { executionBindings } from "../test/execution-bindings.ts";
import { withContactDatabase } from "./discovery/contact.test-helper.ts";
import { notificationFixture } from "./discovery/notifications.test-helper.ts";

test("the execution tick sends through the dedicated Mac RPC even when Persona startup is unavailable, without replay on replacement", () =>
  withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* notificationFixture;
        const context = Context.make(SqlClient.SqlClient, yield* SqlClient.SqlClient);
        const messages = fakeMessages();
        const submitted: string[] = [];
        const gateway = messageGateway(
          messages.messages,
          "management-secret",
          fakeGestures().gestures,
          {
            ...fakeNotifications(),
            sendText: (handle, text) =>
              Effect.sync(() => {
                submitted.push(text);
                expect(handle).toBe("+821012345678");
                return { guid: "notification-guid" };
              }),
            status: () => Effect.succeed({ state: "delivered", error: 0, dateRead: null }),
          },
        );
        yield* Effect.addFinalizer(() => Effect.promise(gateway.dispose));
        const open = () =>
          createExecutionRuntime(
            fromPartial<ApplicationStore>({ context }),
            cloudflareConfiguration(executionBindings),
            executionBindings,
            "ground rules",
            async (input, init) => {
              const request = new Request(input, init);
              if (new URL(request.url).pathname.startsWith("/imsg/rpc"))
                return gateway.handler(new Request("https://imsg.test/rpc", request));
              return new Response("unavailable", { status: 503 });
            },
          );
        expect((yield* f.join()).status).toBe(200);
        for (let replacement = 0; replacement < 2; replacement++) {
          yield* (yield* SqlClient.SqlClient)`UPDATE application_work SET due = 0 WHERE name = 'lane:alarm.cursor:execution'`;
          const runtime = yield* Effect.promise(open);
          try {
            const registrationID = (yield* f.store.list).entries[0]!.id;
            const response = yield* Effect.promise(() =>
              runtime.fetch(
                new Request("https://app/operator/imessage-recheck", {
                  method: "POST",
                  headers: { authorization: "Bearer management-secret" },
                  body: JSON.stringify({ registrationID }),
                }),
              ),
            );
            expect(response.status).toBe(200);
            expect(runtime.initialized).toBe(false);
            yield* Effect.promise(() =>
              expect(runtime.tick()).rejects.toHaveProperty(
                "cause.cause.message",
                "Catalog request failed (503; request unavailable)",
              ),
            );
            expect(yield* f.snapshot).toMatchObject({
              entries: [{ notification: "sent", eligible: true }],
            });
          } finally {
            yield* Effect.promise(runtime.close);
          }
        }
        expect(submitted).toHaveLength(1);
        expect(submitted[0]).toContain("[RenAI]");
        expect(messages.bubbles).toEqual([]);
      }),
    ),
  ));
