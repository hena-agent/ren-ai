import { Effect } from "effect";
import { expect, test } from "vitest";
import { captureGatewayLogs, gatewayFixture } from "../../test/gateway.test-helper.ts";

test("availability RPC returns a correlated lookup without sending and preserves safe failure diagnostics", async () => {
  const f = gatewayFixture();
  const { logs, restore } = captureGatewayLogs();
  try {
    await f.run((remote) =>
      Effect.gen(function* () {
        const result = yield* remote.availability("+821012345678");
        expect(result.requestId).toEqual(expect.any(String));
        expect(result).toMatchObject({
          available: true,
        });
        f.local.messages.availability = () => Effect.succeed({ available: false });
        expect(yield* remote.availability("person@example.com")).toMatchObject({
          available: false,
        });
        f.local.messages.availability = () =>
          Effect.fail(
            Object.assign(new Error("private +821012345678"), { code: "IDS_LOOKUP_FAILED" }),
          );
        const error = yield* remote.availability("+821012345678").pipe(Effect.flip);
        const requestId = error.message.match(/request ([0-9a-f-]{36})/)?.[1];
        expect(requestId).toBeDefined();
        expect(error).toMatchObject({ requestId });
        expect(logs.filter((line) => line.includes(requestId!)).join("\n")).toContain(
          "IDS_LOOKUP_FAILED",
        );
        expect(error.message).not.toContain("private");
        expect(f.local.bubbles).toEqual([]);
        expect(yield* f.local.messages.after(0)).toEqual([]);
      }),
    );
    expect(logs.join("\n")).not.toMatch(/821012345678|person@example.com|private/);
  } finally {
    restore();
    await f.server.dispose();
  }
});
