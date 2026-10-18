import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import { bridgeFixture, cleanup, rustpushFixture, service } from "../../test/bridge.test-helper.ts";
import { captureGatewayLogs, gatewayFixture } from "../../test/gateway.test-helper.ts";

afterEach(cleanup);

test.each(["accepted", "unsent"])(
  "a late %s Notification settlement failure keeps its GUID and logs the SQLite cause",
  async (outcome) => {
    const native = rustpushFixture(bridgeFixture([service, "mailto:noti@renai.im"]), 20);
    const { logs, restore } = captureGatewayLogs();
    native.bridge.answer("send", "hang");
    try {
      await native.run(({ messages, notifications }) =>
        Effect.gen(function* () {
          // Inject a real storage failure without mocking the adapter or inspecting its private rows.
          const storage = new DatabaseSync(join(native.directory, "notifications.sqlite"));
          storage.exec(
            "CREATE TRIGGER refuse_settlement BEFORE UPDATE ON message BEGIN SELECT RAISE(FAIL, 'private-storage-detail'); END",
          );
          storage.close();
          const gateway = gatewayFixture(messages, notifications);
          yield* Effect.addFinalizer(() => Effect.promise(gateway.server.dispose));
          yield* Effect.promise(() =>
            gateway.run((remote) =>
              Effect.gen(function* () {
                const result = yield* remote.notify("+821012345678", "private-notification-text");
                const send = native.bridge.requests.find((request) => request.method === "send")!;
                native.bridge.raw(
                  JSON.stringify({
                    id: send.id,
                    ...(outcome === "accepted"
                      ? { result: { status: "sent" } }
                      : {
                          error: {
                            stage: "input",
                            cause: { code: "sender_not_registered" },
                            requestId: send.requestId,
                          },
                        }),
                  }),
                );
                yield* Effect.promise(() =>
                  vi.waitFor(() =>
                    expect(
                      logs.filter((line) => line.includes(result.requestId)).join("\n"),
                    ).toContain("ERR_SQLITE_ERROR"),
                  ),
                );
                expect((yield* remote.notificationStatus(result.guid)).state).toBe("pending");
                expect(
                  native.bridge.requests.filter((request) => request.method === "send"),
                ).toHaveLength(1);
              }),
            ),
          );
        }),
      );
      for (const secret of ["private-storage-detail", "private-notification-text", "+821012345678"])
        expect(logs.join("\n")).not.toContain(secret);
    } finally {
      restore();
    }
  },
);
