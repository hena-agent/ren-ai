import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { operatorHandler } from "./api.ts";
import { makeOperator } from "./operator.ts";

test("an operator removes a Waitlist-only email without touching any User", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO waitlist (email, locale, answer, created_at)
      VALUES ('only@example.com', 'ko', 'full', 1)`;
      const operator = yield* makeOperator(yield* conversations, () => Effect.void);
      expect(yield* operator.removeWaitlist("only@example.com")).toBe("removed");
      expect(yield* sql`SELECT email FROM waitlist`).toEqual([]);
      expect(yield* operator.removeWaitlist("only@example.com")).toBe("not_found");
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );
});

test("the operator rejects invalid emails and reports Waitlist removal failures", async () => {
  const api = operatorHandler({
    block: () => Effect.void,
    remove: () => Effect.succeed("not_found"),
    removeWaitlist: () => Effect.fail(new Error("database offline")),
  });
  const request = (email: string) =>
    api.handler(
      new Request("http://operator/remove-waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      }),
    );
  try {
    for (const email of ["bad", "USER@EXAMPLE.COM"]) {
      const response = await request(email);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ reason: "Error: Invalid email" });
    }
    const failed = await request("only@example.com");
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ reason: "Error: database offline" });
  } finally {
    await api.dispose();
  }
});
