import { SqliteClient } from "@effect/sql-sqlite-node";
import { ConfigProvider, Effect } from "effect";
import { expect, test } from "vitest";
import { serveTestOperator } from "../../test/operator-http.test-helper.ts";
import { captureDiagnostics } from "../../test/diagnostics.test-helper.ts";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { operatorHandler } from "./api.ts";
import { runOperatorCli } from "./cli.ts";
import { makeOperator } from "./operator.ts";

test("the authenticated operator command controls photo-taking and reports persistence failures safely", async () => {
  const { logs, restore } = captureDiagnostics();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* migrate;
          const directory = yield* conversations;
          const unavailable = yield* makeOperator(directory, () => Effect.void);
          expect(yield* unavailable.photoTaking(true).pipe(Effect.flip)).toEqual(
            new Error("Conversation photos unavailable"),
          );
          const changes: boolean[] = [];
          const operations = yield* makeOperator(
            directory,
            () => Effect.void,
            undefined,
            undefined,
            (enabled) =>
              Effect.sync(() => {
                changes.push(enabled);
              }),
          );
          let failing = false;
          const api = operatorHandler({
            ...operations,
            releaseSend: () => Effect.succeed("not_found"),
            photoTaking: (enabled) =>
              failing
                ? Effect.fail(Object.assign(new Error("private-prompt"), { code: "SQLITE_BUSY" }))
                : operations.photoTaking(enabled),
          });
          yield* Effect.addFinalizer(() => Effect.promise(api.dispose));
          const connection = yield* serveTestOperator(api.handler);
          expect(yield* runOperatorCli(["photos", "off"], connection)).toBe("Photo-taking off");
          expect(
            yield* runOperatorCli(["photos", "on"]).pipe(
              Effect.provide(
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({
                    API_APP_URL: connection.url,
                    TOKEN_MANAGEMENT: connection.token,
                  }),
                ),
              ),
            ),
          ).toBe("Photo-taking on");
          expect(changes).toEqual([false, true]);
          for (const args of [["photos"], ["photos", "maybe"], ["photos", "on", "extra"]]) {
            const failure = yield* runOperatorCli(args, connection).pipe(Effect.flip);
            if (!(failure instanceof Error)) throw new Error("Expected a usage error");
            expect(failure.message).toContain("Usage:");
          }
          failing = true;
          const failure = yield* runOperatorCli(["photos", "off"], connection).pipe(Effect.flip);
          expect(failure).toHaveProperty("reason");
          expect(JSON.stringify(failure)).toMatch(/Photo setting failed \(request [\da-f-]+\)/);
          expect(logs.join("\n")).toContain("SQLITE_BUSY");
          expect(logs.join("\n")).toContain("setting.persist");
          expect(logs.join("\n")).not.toContain("private-prompt");
        }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
      ),
    );
  } finally {
    restore();
  }
});
