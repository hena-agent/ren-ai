import { createHash } from "node:crypto";
import { Context, Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { expect, test, vi } from "vitest";
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
  handle: "+821012345678",
  locale: "ko",
  privacyNoticeVersion: discoveryNotice.version,
  turnstileToken: "human",
  name: "민수",
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

test("ended selections are silently removed, and rejected selections spend no registration credit", async () => {
  await run(
    Effect.gen(function* () {
      const { web, sql } = yield* setup();
      yield* sql`INSERT INTO persona_exclusion VALUES (${input.handle}, 'ended')`;
      yield* Effect.promise(async () => {
        try {
          const empty = await post(web, { ...input, likedPersonaIDs: ["ended"] });
          expect(await empty.json()).toBe("ended_personas");
          const stale = await post(web, { ...input, likedPersonaIDs: ["missing"] });
          expect(await stale.json()).toBe("personas");
          const accepted = await post(web, { ...input, likedPersonaIDs: ["ended", "luna"] });
          expect(accepted.status).toBe(200);
          expect(await accepted.json()).toEqual({ status: "waiting" });
        } finally {
          await web.dispose();
        }
      });
      expect(yield* sql`SELECT persona_id FROM discovery_like`).toEqual([{ persona_id: "luna" }]);
      expect(yield* sql`SELECT COUNT(*) AS n FROM discovery_attempt`).toEqual([{ n: 1 }]);
    }),
  );
});

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
            { handle: "hello@example.net" },
            { handle: "+8221234567" },
            { handle: "+827012345678" },
            { locale: "de" },
            { turnstileToken: "" },
            { name: " " },
            { name: undefined },
            { name: "" },
            { name: null },
            { name: "a".repeat(101) },
            { age: 0 },
            { age: -1 },
            { age: 1.5 },
            { age: "28" },
            { gender: "invalid" },
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

test("mobile numbers from any country register in international form", async () => {
  await run(
    Effect.gen(function* () {
      const { web, sql } = yield* setup();
      yield* Effect.tryPromise(async () => {
        try {
          for (const handle of ["+14155550100", "+819012345678"])
            expect((await post(web, { ...input, handle })).status).toBe(200);
        } finally {
          await web.dispose();
        }
      });
      expect(
        yield* sql<{ handle: string }>`SELECT handle FROM discovery_registration ORDER BY handle`,
      ).toEqual([{ handle: "+14155550100" }, { handle: "+819012345678" }]);
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

test("the public API allows the Discovery origin and rejects unrelated origins", async () => {
  await run(
    Effect.gen(function* () {
      const { web } = yield* setup();
      yield* Effect.tryPromise(async () => {
        try {
          for (const origin of ["https://renai.im"]) {
            const allowed = await web.handler(
              new Request("http://localhost/discovery/personas?locale=ko", {
                headers: { Origin: origin },
              }),
              Context.make(HttpClient.HttpClient, verified),
            );
            expect(allowed.headers.get("access-control-allow-origin")).toBe(origin);
            const preflight = await web.handler(
              new Request("http://localhost/discovery/waitlist", {
                method: "OPTIONS",
                headers: {
                  Origin: origin,
                  "Access-Control-Request-Method": "POST",
                  "Access-Control-Request-Headers": "content-type",
                },
              }),
              Context.make(HttpClient.HttpClient, verified),
            );
            expect(preflight.status).toBe(204);
            expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
            expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
          }
          const denied = await web.handler(
            new Request("http://localhost/discovery/personas?locale=ko", {
              headers: { Origin: "https://unrelated.example" },
            }),
            Context.make(HttpClient.HttpClient, verified),
          );
          expect(denied.headers.get("access-control-allow-origin")).not.toBe(
            "https://unrelated.example",
          );
        } finally {
          await web.dispose();
        }
      });
    }),
  );
});

const answering = (answer: () => Response) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, answer())));

test("failed human checks spend no registration credit, while a separate gate bounds verification calls", async () => {
  await run(
    Effect.gen(function* () {
      const { web, sql } = yield* setup();
      let calls = 0;
      const rejected = answering(() => {
        calls++;
        return Response.json({ success: false });
      });
      yield* Effect.tryPromise(async () => {
        try {
          for (let i = 0; i < 8; i++)
            expect(await (await post(web, input, "shared-ip", rejected)).json()).toBe(
              "verification",
            );
          expect((await post(web, input, "shared-ip")).status).toBe(200);
          for (let i = 0; i < 30; i++) await post(web, input, "abusive-ip", rejected);
          const limited = await post(web, input, "abusive-ip", rejected);
          expect(limited.status).toBe(429);
          expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
          expect(await limited.json()).toBe("try_later");
          expect(calls).toBe(38);
        } finally {
          await web.dispose();
        }
      });
      expect(yield* sql`SELECT COUNT(*) AS n FROM discovery_attempt`).toEqual([{ n: 1 }]);
    }),
  );
});

test("verification failures, missing secrets and outages never admit a registration", async () => {
  const rejecting = [
    () => Response.json({ success: false }),
    () => Response.json({ success: true }, { status: 503 }),
    () => Response.json(null),
    () => Response.json("success"),
    () => Response.json({}),
  ].map(answering);
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
          for (const [index, client] of [...rejecting, outage].entries()) {
            const response = await post(web, input, `visitor-${index}`, client);
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
      yield* sql`INSERT INTO blocked (handle, blocked_at) VALUES ('+821011112222', 1)`;
      yield* sql`INSERT INTO removal (handle, session_id) VALUES ('+821033334444', 'removed-session')`;
      yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, joined_at) VALUES ('+821055556666', 'ko', 'v1', 'ko', 1, 2)`;
      yield* Effect.tryPromise(async () => {
        try {
          for (const handle of ["+821011112222", "+821033334444"]) {
            const response = await post(web, { ...input, handle });
            expect(response.status).toBe(400);
            expect(await response.json()).toBe("unavailable");
          }
          const response = await post(web, { ...input, handle: "+821055556666" });
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ status: "active" });
        } finally {
          await web.dispose();
        }
      });
      expect(yield* sql`SELECT id FROM discovery_registration`).toEqual([]);
      expect(yield* sql`SELECT id FROM user`).toHaveLength(1);
      expect(yield* sql`SELECT COUNT(*) AS n FROM discovery_attempt`).toEqual([{ n: 1 }]);
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
            new Request("http://localhost/discovery/personas?locale=ko"),
            Context.make(HttpClient.HttpClient, verified),
          );
          expect(profiles.status).toBe(503);
          expect(await profiles.json()).toBe("storage");
          expect((await post(web, input)).status).toBe(503);
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
          expect(response.status).toBe(503);
          expect(await response.json()).toBe("storage");
        } finally {
          await working.dispose();
        }
      });
      expect(yield* sql`SELECT id FROM discovery_registration`).toEqual([]);
      expect(yield* sql`SELECT ip FROM discovery_attempt`).toEqual([]);
    }),
  );
});

test("one IP is limited after thirty successful requests and other visitors can still register", async () => {
  await run(
    Effect.gen(function* () {
      const { web, sql } = yield* setup();
      const ip = createHash("sha256").update("visitor").digest("hex");
      const now = Date.now();
      yield* sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 30)
        INSERT INTO discovery_attempt (ip, at) SELECT ${ip}, ${now} FROM n`;
      yield* Effect.tryPromise(async () => {
        try {
          const limited = await post(web, input);
          expect(limited.status).toBe(429);
          expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(3599);
          expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(3600);
          expect(await limited.json()).toBe("try_later");
          expect((await post(web, { ...input, handle: "+821087654321" }, "other")).status).toBe(
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

test("rate-limit persistence failure denies registration with a payload-free diagnostic", () =>
  run(
    Effect.gen(function* () {
      const { web, sql } = yield* setup();
      yield* sql`CREATE TRIGGER fail_attempt BEFORE INSERT ON discovery_attempt BEGIN SELECT RAISE(ABORT, 'private limiter detail'); END`;
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      yield* Effect.promise(async () => {
        try {
          const response = await post(web, input);
          expect(response.status).toBe(503);
          expect(await response.json()).toBe("storage");
          const logs = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
          expect(logs).toContain('"stage":"registration.limit"');
          expect(logs).toContain('"causeName":');
          expect(logs).not.toMatch(/private limiter detail|821012345678|human/);
        } finally {
          stderr.mockRestore();
          await web.dispose();
        }
      });
      expect(yield* sql`SELECT id FROM discovery_registration`).toEqual([]);
    }),
  ));

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
