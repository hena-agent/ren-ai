import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { SqliteClient } from "@effect/sql-sqlite-do";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Activity, MetricsQuery } from "@ren-ai/onboarding";
import { counterSchema, countMetric, countryValue, readTotals, sourceValue } from "./totals.ts";
import { applicationRequest } from "../application-request.ts";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";

export const activityHandler = (storage: DurableObjectStorage) => {
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ storage }))));
  const initialized = run(counterSchema);
  return (request: Request) =>
    applicationRequest(request, async (incoming) => {
      await initialized;
      if (incoming.method === "GET") {
        const query = Schema.decodeUnknownSync(MetricsQuery)(
          Object.fromEntries(new URL(incoming.url).searchParams),
        );
        return Response.json(await run(readTotals(query)));
      }
      let activity: Activity;
      try {
        const text = await incoming.text();
        if (text.length > 2048) return new Response(null, { status: 413 });
        activity = Schema.decodeUnknownSync(Schema.fromJsonString(Activity), {
          onExcessProperty: "error",
        })(text);
      } catch (cause) {
        contactLog({
          requestId: incoming.headers.get("X-Operation-ID")!,
          operation: "metrics.activity",
          stage: "activity.validate",
          outcome: "failed",
          level: "warn",
          durationMs: 0,
          code: "invalid_activity",
          ...contactCause(cause),
        });
        return new Response(null, { status: 400 });
      }
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* Effect.gen(function* () {
            const source = sourceValue(activity.source);
            yield* countMetric(activity.step, Date.now(), [
              ["source", source],
              [
                "country",
                countryValue(activity.visitCountry ?? incoming.headers.get("CF-IPCountry")),
              ],
              ["device", activity.device],
              ["locale", activity.locale],
              ["imageStyle", activity.imageStyle],
              ...(activity.persona ? [["persona", activity.persona] as const] : []),
            ]);
          }).pipe(sql.withTransaction);
        }),
      );
      return new Response(null, {
        status: 204,
        headers: { "X-Visit-Country": countryValue(incoming.headers.get("CF-IPCountry")) },
      });
    });
};
