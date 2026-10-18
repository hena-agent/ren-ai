import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { authorize } from "@ren-ai/transport/server";
import { scheduleWork } from "../scheduling.ts";
import type { ApplicationStore } from "../application-store.ts";

export const intakeRequests = (store: ApplicationStore, token: string) =>
  authorize(async (request) => {
    const path = new URL(request.url).pathname;
    const method = path === "/management/intake/watch" ? "GET" : "POST";
    if (request.method !== method)
      return new Response(null, { status: 405, headers: { Allow: method } });
    if (method === "POST") {
      await store.run(scheduleWork("intake", Date.now()));
      return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    const snapshot = await store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [bookmark] = yield* sql<{
          rowID: number;
        }>`SELECT row_id AS rowID FROM bookmark WHERE id = 1`;
        const watched = yield* sql<{
          guid: string;
          handle: string;
          text: string;
          createdAt: number;
        }>`
      SELECT e.guid, u.handle, e.text, e.created_at AS createdAt FROM intake_edit e JOIN conversation c ON c.session_id = e.session_id
      JOIN user u ON u.id = c.user_id WHERE e.created_at >= ${Date.now() - 900_000} AND e.text != '' AND c.ended_at IS NULL`;
        return { rowID: bookmark?.rowID ?? 0, watched };
      }),
    );
    return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  }, token);
