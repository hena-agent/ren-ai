import { ConfigProvider, Effect, Result } from "effect";
import { expect, test } from "vitest";
import { serveTestOperator } from "../../test/operator-http.test-helper.ts";
import { runOperatorCli } from "./cli.ts";
import { operatorClient } from "./clientHttp.ts";

test("CLI configuration uses the central URL and management token, not a state directory", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* serveTestOperator(async (request) => {
          expect(new URL(request.url).pathname).toBe("/block");
          expect(await request.json()).toEqual({ handle: "user@example.com" });
          return Response.json({ blocked: true });
        });
        const configured = runOperatorCli(["block", "user@example.com"]).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                API_APP_URL: `${connection.url}/`,
                TOKEN_MANAGEMENT: connection.token,
              }),
            ),
          ),
        );
        expect(yield* configured).toBe("Blocked user@example.com");
        const missing = yield* Effect.result(
          runOperatorCli(["block", "user@example.com"]).pipe(
            Effect.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ STATE_DIRECTORY: "/unused" })),
            ),
          ),
        );
        expect(Result.isFailure(missing)).toBe(true);
      }),
    ),
  );
});

test("the HTTP client rejects malformed success payloads instead of reporting operator success", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* serveTestOperator(async () =>
          Response.json({ result: "invalid" }),
        );
        const client = yield* operatorClient(connection);
        const answer = yield* Effect.result(
          client.operator.remove({ payload: { handle: "user@example.com" } }),
        );
        expect(Result.isFailure(answer)).toBe(true);
      }),
    ),
  );
});
