import { Effect } from "effect";
import { expect, test } from "vitest";
import { captureGatewayLogs, gatewayFixture } from "../../test/gateway.test-helper.ts";

test("history RPC bounds pages and reports read failures with payload-free diagnostics", async () => {
  const f = gatewayFixture();
  const logging = captureGatewayLogs();
  try {
    await f.run((remote) =>
      Effect.gen(function* () {
        for (let id = 1; id <= 70; id++) yield* f.local.text("user", `sensitive text ${id}`, id);
        const first = yield* remote.history({ handle: "user", since: 5, until: 65 });
        expect(first).toHaveLength(51);
        expect(first[0]?.createdAt).toBe(64);
        const second = yield* remote.history({
          handle: "user",
          since: 5,
          until: 65,
          before: first[49]!.id,
        });
        expect(second[0]?.createdAt).toBe(14);
        expect(second.at(-1)?.createdAt).toBe(5);
        expect(second.every((row) => row.status === null)).toBe(true);
        f.local.messages.recent = () =>
          Effect.fail(Object.assign(new Error("private upstream text"), { code: "SQLITE_BUSY" }));
        const failure = yield* remote
          .history({ handle: "user", since: 0, until: null })
          .pipe(Effect.flip);
        expect(failure.requestId).toBeTruthy();
        const diagnostics = logging.logs.join("");
        expect(diagnostics).toContain(failure.requestId);
        expect(diagnostics).toContain("messages.history");
        expect(diagnostics).toContain("SQLITE_BUSY");
        expect(diagnostics).not.toContain("sensitive text");
        expect(diagnostics).not.toContain("private upstream text");
      }),
    );
  } finally {
    await f.server.dispose();
    logging.restore();
  }
});
