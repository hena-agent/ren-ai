import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { InvitationCode } from "@ren-ai/onboarding";
import { authorize } from "@ren-ai/transport/authorization";
import type { ApplicationStore } from "../application-store.ts";

export function invitationAvailability(request: Request, store: ApplicationStore, token: string) {
  return authorize(async () => {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const code = new URL(request.url).searchParams.get("code");
    if (!Schema.is(InvitationCode)(code)) return new Response(null, { status: 400 });
    const available = await store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows =
          yield* sql`SELECT 1 FROM invitation WHERE token=${code} AND used_count < max_uses LIMIT 1`;
        return rows.length === 1;
      }),
    );
    return Response.json({ available }, { headers: { "Cache-Control": "no-store" } });
  }, token)(request);
}
