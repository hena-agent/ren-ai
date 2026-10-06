import { Context, Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { discoveryNotice } from "@ren-ai/onboarding";
import { migrate } from "../database.ts";
import { makeDiscoveryWeb } from "./discovery.ts";

const listed = [
  {
    id: "luna",
    name: "루나",
    bio: "카페에서 글을 써요.",
    imageUrl: "https://example.net/luna.jpg",
  },
];
const input = {
  handle: "hello@example.net",
  locale: "ko",
  privacyNoticeVersion: discoveryNotice.version,
  turnstileToken: "human",
  likedPersonaIDs: ["luna"],
};
const verified = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: true }))),
);
type Web = Effect.Success<ReturnType<typeof makeDiscoveryWeb>>;

const run = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(program.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))));
const setup = (secret = "secret", catalog = async () => listed) =>
  Effect.gen(function* () {
    yield* migrate;
    const web = yield* makeDiscoveryWeb({ catalog, turnstileSecret: secret });
    const sql = yield* SqlClient.SqlClient;
    return { web, sql };
  });
const post = (web: Web, payload: object, ip = "visitor", client = verified) =>
  web.handler(
    new Request("http://localhost/discovery/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify(payload),
    }),
    Context.make(HttpClient.HttpClient, client),
  );

test("request schemas reject missing, empty, duplicate, uncanonical and unsafe selections", async () => {
  await run(
    Effect.gen(function* () {
      const { web, sql } = yield* setup();
      yield* Effect.tryPromise(async () => {
        try {
          for (const changed of [
            { likedPersonaIDs: [] },
            { likedPersonaIDs: ["luna", "luna"] },
            { likedPersonaIDs: ["../secret"] },
            { handle: "010-1234-5678" },
            { handle: "A@EXAMPLE.NET" },
            { locale: "en" },
            { turnstileToken: "" },
          ]) {
            const result = await post(web, { ...input, ...changed });
            expect(result.status).toBe(400);
          }
          expect((await post(web, { ...input, privacyNoticeVersion: "old" })).status).toBe(400);
          expect((await post(web, { ...input, likedPersonaIDs: ["unpublished"] })).status).toBe(
            400,
          );
          expect(
            (await post(web, { ...input, likedPersonaIDs: ["luna", "unpublished"] }, "mixed"))
              .status,
          ).toBe(400);
        } finally {
          await web.dispose();
        }
      });
      expect(yield* sql`SELECT id FROM discovery_registration`).toEqual([]);
    }),
  );
});

test("the current web disclosure must be available and matching", async () => {
  const original = discoveryNotice.version;
  try {
    await run(
      Effect.gen(function* () {
        const { web } = yield* setup();
        discoveryNotice.version = "pending";
        yield* Effect.tryPromise(async () => {
          try {
            const response = await post(web, { ...input, privacyNoticeVersion: "pending" });
            expect(response.status).toBe(400);
            expect(await response.json()).toBe("consent");
          } finally {
            await web.dispose();
          }
        });
      }),
    );
  } finally {
    discoveryNotice.version = original;
  }
});

test("the public API allows only the documented browser origin", async () => {
  await run(
    Effect.gen(function* () {
      const { web } = yield* setup();
      yield* Effect.tryPromise(async () => {
        try {
          const allowed = await web.handler(
            new Request("http://localhost/discovery/personas", {
              headers: { Origin: "https://discovery.hena.dev" },
            }),
            Context.make(HttpClient.HttpClient, verified),
          );
          expect(allowed.headers.get("access-control-allow-origin")).toBe(
            "https://discovery.hena.dev",
          );
          const denied = await web.handler(
            new Request("http://localhost/discovery/personas", {
              headers: { Origin: "https://unrelated.example" },
            }),
            Context.make(HttpClient.HttpClient, verified),
          );
          expect(denied.headers.get("access-control-allow-origin")).toBe(
            "https://discovery.hena.dev",
          );
        } finally {
          await web.dispose();
        }
      });
    }),
  );
});

test("verification failures, missing secrets and outages never admit a registration", async () => {
  const failed = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: false }))),
  );
  const outage = HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "offline" }),
      }),
    ),
  );
  await run(
    Effect.gen(function* () {
      const { web, sql } = yield* setup();
      yield* Effect.tryPromise(async () => {
        try {
          for (const client of [failed, outage]) {
            const response = await post(web, input, "visitor", client);
            expect(response.status).toBe(400);
            expect(await response.json()).toBe("verification");
          }
        } finally {
          await web.dispose();
        }
      });
      const unavailable = yield* makeDiscoveryWeb({
        catalog: async () => listed,
        turnstileSecret: "",
      });
      yield* Effect.tryPromise(async () => {
        try {
          expect((await post(unavailable, input)).status).toBe(400);
        } finally {
          await unavailable.dispose();
        }
      });
      expect(yield* sql`SELECT id FROM discovery_registration`).toEqual([]);
    }),
  );
});

test("blocked and removing handles stay unavailable, while existing conversations stay assigned", async () => {
  await run(
    Effect.gen(function* () {
      const { web, sql } = yield* setup();
      yield* sql`INSERT INTO blocked (handle, blocked_at) VALUES ('blocked@example.net', 1)`;
      yield* sql`INSERT INTO removal (handle, session_id) VALUES ('removing@example.net', 'removed-session')`;
      yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, joined_at) VALUES ('active@example.net', 'ko', 'v1', 'ko', 1, 2)`;
      yield* Effect.tryPromise(async () => {
        try {
          for (const handle of ["blocked@example.net", "removing@example.net"]) {
            const response = await post(web, { ...input, handle });
            expect(response.status).toBe(400);
            expect(await response.json()).toBe("unavailable");
          }
          const response = await post(web, { ...input, handle: "active@example.net" });
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ status: "active" });
        } finally {
          await web.dispose();
        }
      });
      expect(yield* sql`SELECT id FROM discovery_registration`).toEqual([]);
      expect(yield* sql`SELECT id FROM user`).toHaveLength(1);
    }),
  );
});

test("catalog failures and partial database writes fail without a false waiting receipt", async () => {
  await run(
    Effect.gen(function* () {
      const { web, sql } = yield* setup("secret", async () => {
        throw new Error("files unavailable");
      });
      yield* Effect.tryPromise(async () => {
        try {
          const profiles = await web.handler(
            new Request("http://localhost/discovery/personas"),
            Context.make(HttpClient.HttpClient, verified),
          );
          expect(profiles.status).toBe(400);
          expect(await profiles.json()).toBe("storage");
          expect((await post(web, input)).status).toBe(400);
        } finally {
          await web.dispose();
        }
      });
      const working = yield* makeDiscoveryWeb({
        catalog: async () => listed,
        turnstileSecret: "secret",
      });
      yield* sql`CREATE TRIGGER fail_likes BEFORE INSERT ON discovery_like BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END`;
      yield* Effect.tryPromise(async () => {
        try {
          const response = await post(working, input);
          expect(response.status).toBe(400);
          expect(await response.json()).toBe("storage");
        } finally {
          await working.dispose();
        }
      });
      expect(yield* sql`SELECT id FROM discovery_registration`).toEqual([]);
    }),
  );
});

test("one IP is limited after five attempts and other visitors can still register", async () => {
  await run(
    Effect.gen(function* () {
      const { web, sql } = yield* setup();
      yield* Effect.tryPromise(async () => {
        try {
          for (let index = 0; index < 5; index++) expect((await post(web, input)).status).toBe(200);
          const limited = await post(web, input);
          expect(limited.status).toBe(400);
          expect(await limited.json()).toBe("try_later");
          expect((await post(web, { ...input, handle: "other@example.net" }, "other")).status).toBe(
            200,
          );
          const withoutIP = new Request("http://localhost/discovery/waitlist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          });
          expect(
            (await web.handler(withoutIP, Context.make(HttpClient.HttpClient, verified))).status,
          ).toBe(200);
        } finally {
          await web.dispose();
        }
      });
      expect(yield* sql`SELECT id FROM discovery_registration`).toHaveLength(2);
    }),
  );
});

test("simultaneous requests for one handle cannot duplicate preferences", async () => {
  await run(
    Effect.gen(function* () {
      const { web, sql } = yield* setup();
      yield* Effect.tryPromise(async () => {
        try {
          const results = await Promise.all([post(web, input, "a"), post(web, input, "b")]);
          expect(results.map((response) => response.status)).toEqual([200, 200]);
        } finally {
          await web.dispose();
        }
      });
      expect(yield* sql`SELECT id FROM discovery_registration`).toHaveLength(1);
      expect(yield* sql`SELECT persona_id FROM discovery_like`).toHaveLength(1);
    }),
  );
});
