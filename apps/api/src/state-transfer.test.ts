import { fromPartial } from "@total-typescript/shoehorn";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { expect, test } from "vitest";
import { stateTransfer } from "./state-transfer.ts";
import { migrate } from "./database.ts";
import { readStateSnapshot } from "./state-snapshot.ts";
import type { ApplicationStore } from "./application-store.ts";

const request = (path: string, method = "GET", body?: string) =>
  new Request(`https://app.example/management/state/${path}`, {
    method,
    headers: { Authorization: "Bearer secret" },
    ...(body && { body }),
  });

test("private state endpoints require service auth and bootstrap, then restore without exposing archives", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrate;
        const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
          Effect.runPromise(Effect.provideService(effect, SqlClient.SqlClient, sql));
        const store = fromPartial<ApplicationStore>({ run });
        yield* Effect.promise(async () => {
          expect(
            (
              await stateTransfer(
                new Request("https://app.example/management/state/export"),
                store,
                "secret",
                true,
              )
            ).status,
          ).toBe(401);
          expect((await stateTransfer(request("export"), store, "secret", false)).status).toBe(409);
          expect(
            (await stateTransfer(request("export", "POST"), store, "secret", true)).status,
          ).toBe(405);
          expect((await stateTransfer(request("unknown"), store, "secret", true)).status).toBe(405);
          const exported = await stateTransfer(request("export"), store, "secret", true);
          const snapshot = readStateSnapshot(await exported.json());
          expect(exported.headers.get("cache-control")).toBe("no-store");
          const imported = await stateTransfer(
            request("import", "POST", JSON.stringify(snapshot)),
            store,
            "secret",
            true,
          );
          expect(imported.status).toBe(200);
          expect(await imported.text()).not.toContain("rows");
          await expect(
            stateTransfer(
              request("import", "POST", '"private archive value"'),
              store,
              "secret",
              true,
            ),
          ).rejects.toThrow("Invalid application state snapshot");
        });
      }),
    ).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );
});
