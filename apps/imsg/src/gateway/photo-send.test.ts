import { Effect } from "effect";
import { expect, test } from "vitest";
import { captureGatewayLogs, gatewayFixture } from "../../test/gateway.test-helper.ts";

test("photo RPC preserves bytes and identity through private history and reports safe correlated failures", async () => {
  const f = gatewayFixture();
  const { logs, restore } = captureGatewayLogs();
  const photo = Buffer.from([255, 216, 255, 224, 1, 255, 217]).toString("base64");
  const handle = "private-recipient@example.test";
  try {
    await f.run((remote) =>
      Effect.gen(function* () {
        const attempt = crypto.randomUUID();
        const sent = yield* remote.sendPhoto(handle, photo, attempt);
        expect(sent.guid).toBe(attempt);
        expect(typeof sent.requestId).toBe("string");
        yield* remote.sendPhoto(handle, photo, attempt);
        expect(
          yield* remote.sendPhoto("another@example.test", photo, attempt).pipe(Effect.flip),
        ).toBeInstanceOf(Error);
        const other = Buffer.from([255, 216, 255, 224, 2, 255, 217]).toString("base64");
        expect(yield* remote.sendPhoto(handle, other, attempt).pipe(Effect.flip)).toBeInstanceOf(
          Error,
        );
        const textAttempt = crypto.randomUUID();
        yield* f.local.messages.sendText(handle, "text", textAttempt);
        expect(
          yield* remote.sendPhoto(handle, photo, textAttempt).pipe(Effect.flip),
        ).toBeInstanceOf(Error);
        const fenced = crypto.randomUUID();
        expect(yield* remote.resolveSend(fenced)).toBe("failed");
        yield* remote.sendPhoto(handle, photo, fenced);
        expect(yield* remote.resolveSend(attempt)).toBe("sent");
        const entries = yield* remote.history({ handle, since: 0, until: null });
        expect(entries).toHaveLength(2);
        const attachment = entries.find((row) => row.guid === attempt)!.attachments![0]!;
        expect(attachment.path).not.toContain("/fake/photos");
        expect(yield* remote.image(attachment)).toEqual({ uri: `data:image/jpeg;base64,${photo}` });
        expect(f.local.bubbles).toEqual([{ handle, text: "text" }]);
      }),
    );
    for (const secret of [photo, handle, "/fake/photos"])
      expect(logs.join("\n")).not.toContain(secret);
  } finally {
    restore();
    await f.server.dispose();
  }
});
