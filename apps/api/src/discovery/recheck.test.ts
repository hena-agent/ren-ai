import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { remoteMessages } from "@ren-ai/imsg/client";
import { expect, test, vi } from "vitest";
import { withContactDatabase, contactFixture } from "./contact.test-helper.ts";
import { recheckRequest } from "./recheck.ts";
import type { ContactDiagnostic } from "./diagnostics.ts";

test("operator recheck replaces stored verdicts and safe reasons without sending, selecting or changing siblings", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      const id = yield* f.register("+821072238646");
      const sibling = yield* f.register("sibling@example.net");
      const context = yield* Effect.context<SqlClient.SqlClient>();
      const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        Effect.runPromise(Effect.provideContext(effect, context));
      const availability = vi.fn<Effect.Success<ReturnType<typeof remoteMessages>>["availability"]>(
        () => Effect.succeed({ available: false, requestId: "mac-request" }),
      );
      const logs: ContactDiagnostic[] = [];
      const call = (body: object | string, method = "POST") =>
        recheckRequest(
          new Request("https://api.test/operator/imessage-recheck", {
            method,
            ...(method !== "GET" && {
              body: typeof body === "string" ? body : JSON.stringify(body),
            }),
          }),
          { availability },
          run,
          (event) => logs.push(event),
        );
      yield* Effect.promise(async () => {
        expect((await call({}, "GET")).status).toBe(405);
        expect((await call("private-invalid-json")).status).toBe(400);
        expect((await call({ registrationID: "private-invalid-id" })).status).toBe(400);
        expect((await call({ registrationID: randomUUID() })).status).toBe(404);
        expect(availability).not.toHaveBeenCalled();
        const result = await call({ registrationID: id });
        expect(result.status).toBe(200);
        expect(result.headers.get("cache-control")).toBe("no-store");
        expect(await result.json()).toHaveProperty("requestId", result.headers.get("x-request-id"));
        expect(
          logs.filter((event) => event.requestId === result.headers.get("x-request-id")),
        ).toHaveLength(2);
      });
      expect((yield* f.store.list).entries.find((entry) => entry.id === id)).toMatchObject({
        eligible: false,
        reason: "no_imessage",
        imessage: { status: "unavailable" },
      });
      for (const [failure, reason] of [
        [new Error("private-token +821072238646"), "메시징 서비스 조회에 실패"],
        [Object.assign(new Error("private-token"), { name: "TimeoutError" }), "10초"],
        [
          new Error(
            "Messaging operation failed [stage=ids_lookup;code=6005] (request private-token)",
          ),
          "ids_lookup / 6005",
        ],
      ] as const) {
        const response = yield* Effect.promise(() =>
          recheckRequest(
            new Request("https://api.test/operator/imessage-recheck", {
              method: "POST",
              body: JSON.stringify({ registrationID: id }),
            }),
            { availability: () => Effect.fail(failure) },
            run,
            (event) => logs.push(event),
          ),
        );
        expect(response.status).toBe(200);
        const row = (yield* f.store.list).entries.find((entry) => entry.id === id)!;
        expect(row.imessage?.status).toBe("failed");
        expect(row.imessage?.reason).toContain(reason);
        expect(JSON.stringify(row.imessage)).not.toContain("private-token");
      }
      yield* Effect.promise(() =>
        recheckRequest(
          new Request("https://api.test/operator/imessage-recheck", {
            method: "POST",
            body: JSON.stringify({ registrationID: id }),
          }),
          { availability: () => Effect.succeed({ available: true, requestId: "mac-request" }) },
          run,
          (event) => logs.push(event),
        ),
      );
      const row = (yield* f.store.list).entries.find((entry) => entry.id === id)!;
      expect(row).toMatchObject({ eligible: true, imessage: { status: "available" } });
      expect(row.imessage).not.toHaveProperty("reason");
      expect(
        (yield* f.store.list).entries.find((entry) => entry.id === sibling)?.imessage?.checkedAt,
      ).toBe(123);
      expect(yield* f.sql`SELECT * FROM discovery_contact`).toEqual([]);
      expect(yield* f.sql`SELECT * FROM notification_attempt`).toEqual([]);
      yield* f.sql`CREATE TRIGGER reject_lookup BEFORE UPDATE OF imessage_status ON discovery_registration BEGIN SELECT RAISE(ABORT, 'private-token'); END`;
      const failure = yield* Effect.promise(() => call({ registrationID: id }));
      expect(failure.status).toBe(503);
      expect(JSON.stringify(logs)).not.toMatch(/private-token|821072238646|sibling@example.net/);
    }),
  ));
