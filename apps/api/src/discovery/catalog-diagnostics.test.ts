import { expect, test } from "vitest";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Context, Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { contactCause } from "./diagnostics.ts";
import { catalogClient } from "../personas/catalog.ts";
import { makeDiscoveryWeb } from "./discovery.ts";
import { migrate } from "../database.ts";

test("Catalog failures retain allowlisted status and cause code without the upstream body or credentials", async () => {
  const client = catalogClient(
    { url: "https://catalog.example", token: "private-token" },
    async () => new Response("private prompt private-token", { status: 502 }),
  );
  const diagnostic = await client.load().catch(contactCause);
  expect(diagnostic).toMatchObject({ causeCode: "CATALOG_REQUEST_FAILED", upstreamStatus: 502 });
  expect(JSON.stringify(diagnostic)).not.toContain("private prompt");
  expect(JSON.stringify(diagnostic)).not.toContain("private-token");
  for (const upstreamStatus of ["502", NaN, 502.5, 99, 600])
    expect(
      contactCause(Object.assign(new Error("private"), { upstreamStatus })),
    ).not.toHaveProperty("upstreamStatus");
});

test("Discovery maps an invalid Catalog profile to storage and logs correlated safe diagnostics", async () => {
  const events: object[] = [];
  const requestId = "00000000-0000-4000-8000-000000000017";
  const web = await Effect.runPromise(
    Effect.gen(function* () {
      yield* migrate;
      return yield* makeDiscoveryWeb({
        catalog: () =>
          catalogClient({ url: "http://localhost:3729", token: "private-token" }, async () =>
            Response.json([
              {
                id: "sora",
                name: "Sora",
                bio: "Private persona description",
                imageUrl: "http://admin.renai.im/images/private.png",
              },
            ]),
          ).publicList(),
        turnstileSecret: "secret",
        log: (event) => events.push(event),
      });
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );
  try {
    const response = await web.handler(
      new Request("http://localhost/discovery/personas", {
        headers: { "X-Operation-ID": requestId },
      }),
      Context.make(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => HttpClientResponse.fromWeb(request, Response.json({}))),
        ),
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toBe("storage");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      requestId,
      operation: "discovery.catalog",
      stage: "catalog.read",
      outcome: "failed",
      level: "error",
      code: "storage",
      causeCode: "CATALOG_INVALID_PUBLIC_RESPONSE",
      causeName: "Error",
    });
    expect(JSON.stringify(events)).not.toContain("Private persona description");
    expect(JSON.stringify(events)).not.toContain("private-token");
    expect(JSON.stringify(events)).not.toContain("private.png");
  } finally {
    await web.dispose();
  }
});
