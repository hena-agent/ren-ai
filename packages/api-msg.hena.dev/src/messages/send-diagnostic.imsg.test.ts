import { Effect, Fiber, Result } from "effect";
import { expect, test } from "vitest";
import { fixture, handle } from "./imsg.fake.ts";
import { makeImsgMessages } from "./imsg.ts";
import { captureSendLogs } from "./send-diagnostic.test-helper.ts";
import { sendDiagnostic } from "./send-diagnostic.ts";

test("temporary imsg diagnosis redacts a successful acknowledgement, including an absent GUID", async () => {
  const f = fixture();
  const { logs, records, logger } = captureSendLogs();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const debug = sendDiagnostic();
        const messages = yield* makeImsgMessages(f.alertsService, debug);
        f.noGUID();
        yield* messages.sendText(handle, "unclaimed");
        expect(logs).toEqual([]);
        yield* debug.claim(17, "PRIVATE_HANDLE_SENTINEL", "PRIVATE_TEXT_SENTINEL");
        expect(
          yield* messages.sendText("PRIVATE_HANDLE_SENTINEL", "PRIVATE_TEXT_SENTINEL"),
        ).toEqual({
          guid: null,
        });
        f.hang("send");
        const sending = yield* Effect.forkScoped(
          messages.sendText("PRIVATE_HANDLE_SENTINEL", "PRIVATE_TEXT_SENTINEL"),
        );
        for (
          let i = 0;
          i < 100 && f.commands.filter((item) => item.method === "send").length < 3;
          i++
        )
          yield* Effect.yieldNow;
        f.connections[0]!.close();
        expect(Result.isFailure(yield* Effect.result(Fiber.join(sending)))).toBe(true);
      }).pipe(Effect.withLogger(logger), Effect.provide(f.dependencies)),
    ),
  );
  expect(logs).toEqual([
    '[DEBUG-ren-ai-send] {"event":"attempt","id":17}',
    '[DEBUG-ren-ai-send] {"event":"rpc-ack","id":17,"fields":["ok"],"ok":true,"transport":null,"status":null,"guidPresent":false}',
    '[DEBUG-ren-ai-send] {"event":"rpc-error","id":17,"code":null}',
  ]);
  expect(logs.join("\n")).not.toContain("PRIVATE_");
  expect(records.join("\n")).not.toContain("PRIVATE_");
  expect(logs.join("\n")).toContain('"event":"rpc-ack"');
  expect(logs.join("\n")).toContain('"guidPresent":false');
  expect(logs.join("\n")).toContain('"event":"rpc-error","id":17,"code":null');
});

test("temporary imsg diagnosis separates numeric RPC errors from rejected acknowledgement schemas", async () => {
  const { logs, records, logger } = captureSendLogs();
  const rpc = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const debug = sendDiagnostic();
        const messages = yield* makeImsgMessages(rpc.alertsService, debug);
        rpc.fail();
        yield* debug.claim(18, handle, "PRIVATE_TEXT_SENTINEL");
        expect(
          Result.isFailure(
            yield* Effect.result(messages.sendText(handle, "PRIVATE_TEXT_SENTINEL")),
          ),
        ).toBe(true);
      }).pipe(Effect.withLogger(logger), Effect.provide(rpc.dependencies)),
    ),
  );
  expect(logs.join("\n")).toContain('"event":"rpc-error","id":18,"code":-32001');
  const malformed = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const debug = sendDiagnostic();
        const messages = yield* makeImsgMessages(malformed.alertsService, debug);
        malformed.hang("send");
        yield* debug.claim(19, handle, "PRIVATE_TEXT_SENTINEL");
        const sending = yield* Effect.forkScoped(
          messages.sendText(handle, "PRIVATE_TEXT_SENTINEL"),
        );
        for (let i = 0; i < 100 && !malformed.commands.some((item) => item.method === "send"); i++)
          yield* Effect.yieldNow;
        const id = malformed.commands.find((item) => item.method === "send")!.id;
        malformed.connections[0]!.respond({
          id,
          result: { ok: true, guid: null, secret: "PRIVATE_SECRET_SENTINEL" },
        });
        expect(Result.isFailure(yield* Effect.result(Fiber.join(sending)))).toBe(true);
      }).pipe(Effect.withLogger(logger), Effect.provide(malformed.dependencies)),
    ),
  );
  expect(logs).toEqual([
    '[DEBUG-ren-ai-send] {"event":"attempt","id":18}',
    '[DEBUG-ren-ai-send] {"event":"rpc-error","id":18,"code":-32001}',
    '[DEBUG-ren-ai-send] {"event":"attempt","id":19}',
    '[DEBUG-ren-ai-send] {"event":"rpc-ack","id":19,"fields":["ok","guid"],"ok":true,"transport":null,"status":null,"guidPresent":false}',
    '[DEBUG-ren-ai-send] {"event":"ack-rejected","id":19}',
  ]);
  expect(logs.join("\n")).toContain('"event":"ack-rejected"');
  expect(logs.join("\n")).not.toContain("PRIVATE_");
  expect(records.join("\n")).not.toContain("PRIVATE_");
});

test("an invalid acknowledgement still fails safely when diagnostics are off", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const messages = yield* makeImsgMessages(f.alertsService);
        f.hang("send");
        const sending = yield* Effect.forkScoped(messages.sendText(handle, "message"));
        for (let i = 0; i < 100 && !f.commands.some((item) => item.method === "send"); i++)
          yield* Effect.yieldNow;
        const id = f.commands.find((item) => item.method === "send")!.id;
        f.connections[0]!.respond({ id, result: { ok: true, guid: null } });
        expect(Result.isFailure(yield* Effect.result(Fiber.join(sending)))).toBe(true);
      }).pipe(Effect.provide(f.dependencies)),
    ),
  );
});
