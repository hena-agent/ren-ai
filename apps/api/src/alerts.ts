import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { authorize } from "@ren-ai/transport/server";
import { changeAlert } from "./metrics/discord.ts";
import type { ApplicationStore } from "./application-store.ts";

/** Each change and its Discord message commit together; callers never pass private detail. */
export const applicationAlerts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const change = (name: string, raised: boolean) =>
    changeAlert(name, raised).pipe(
      sql.withTransaction,
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.orDie,
    );
  return {
    raise: (name: string, _detail?: string) => change(name, true),
    clear: (name: string) => change(name, false),
  };
});

const AlertChanges = Schema.fromJsonString(
  Schema.Struct({
    alerts: Schema.Array(Schema.Struct({ name: Schema.String, raised: Schema.Boolean })),
  }),
);

/** The health monitor reports only changed alert states, so steady health never wakes the application. */
export const alertRequests = (store: ApplicationStore, token: string) =>
  authorize(async (request) => {
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const changes = Schema.decodeUnknownOption(AlertChanges)(await request.text());
    if (Option.isNone(changes))
      return new Response(null, { status: 400, headers: { "Cache-Control": "no-store" } });
    await store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.forEach(
          changes.value.alerts,
          ({ name, raised }) => changeAlert(name, raised),
          {
            discard: true,
          },
        ).pipe(sql.withTransaction);
      }),
    );
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }, token);
