import { createHash } from "node:crypto";
import { Clock, Context, Effect } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { discoveryNotice, discoveryNotices, type DiscoveryRequest } from "@ren-ai/onboarding";
import { expect, test } from "vitest";
import { makeDiscoveryWeb } from "./discovery.ts";
import { contactFixture, withContactDatabase } from "./contact.test-helper.ts";
import type { ContactDiagnostic } from "./diagnostics.ts";
import { applicationRequest } from "../application-request.ts";

const human = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: true }))),
);
const registration: DiscoveryRequest = {
  handle: "+821055556666",
  locale: "ko",
  privacyNoticeVersion: discoveryNotice.version,
  likedPersonaIDs: ["luna"],
  turnstileToken: "private-token",
  name: "private-name",
};
const request = (changes: Partial<DiscoveryRequest> = {}) =>
  new Request("https://api.test/discovery/waitlist", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "private-ip",
      Origin: "https://renai.im",
    },
    body: JSON.stringify({ ...registration, ...changes }),
  });

test("registration rejection diagnostics correlate through the real request boundary without private input", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      const logs: ContactDiagnostic[] = [];
      const web = yield* makeDiscoveryWeb({
        catalog: async () => f.profiles,
        turnstileSecret: "secret",
        log: (event) => logs.push(event),
      });
      yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
      yield* f.sql`INSERT INTO persona_exclusion VALUES (${registration.handle}, 'ended')`;
      for (const [changes, code, stage] of [
        [{ likedPersonaIDs: ["ended"] }, "ended_personas", "selection.ended"],
        [{ likedPersonaIDs: ["missing"] }, "personas", "catalog.selection"],
        [{ privacyNoticeVersion: "old" }, "consent", "consent"],
        [{ reselectionToken: "a".repeat(64) }, "reselection", "registration.commit"],
      ] satisfies [Partial<DiscoveryRequest>, string, string][]) {
        const before = logs.length;
        const response = yield* Effect.promise(() =>
          applicationRequest(request(changes), (incoming) =>
            web.handler(incoming, Context.make(HttpClient.HttpClient, human)),
          ),
        );
        expect(response.status).toBe(400);
        expect(yield* Effect.promise(() => response.json())).toBe(code);
        expect(logs.slice(before)).toEqual([
          expect.objectContaining({
            requestId: response.headers.get("X-Request-ID"),
            code,
            stage,
            level: "warn",
            outcome: "failed",
          }),
        ]);
        expect(response.headers.get("Access-Control-Expose-Headers")).toMatch(/x-request-id/i);
        expect(response.headers.get("Access-Control-Expose-Headers")).toMatch(/retry-after/i);
      }
      expect(JSON.stringify(logs)).not.toMatch(
        /private-token|private-name|private-ip|821055556666/,
      );
      expect(yield* f.sql`SELECT * FROM discovery_attempt`).toEqual([]);
      expect(yield* f.sql`SELECT * FROM discovery_registration`).toEqual([]);
      const notices = yield* Effect.promise(() =>
        web.handler(
          new Request("https://api.test/discovery/notices"),
          Context.make(HttpClient.HttpClient, human),
        ),
      );
      expect(notices.headers.get("Cache-Control")).toBe("no-store");
      expect(yield* Effect.promise(() => notices.json())).toEqual(discoveryNotices);
    }).pipe(Effect.scoped),
  ));

test("concurrent registrations share thirty credits and replacement retains the exact retry deadline", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      const context = Context.make(HttpClient.HttpClient, human).pipe(
        Context.add(Clock.Clock, yield* Clock.Clock),
      );
      const create = () =>
        makeDiscoveryWeb({
          catalog: async () => f.profiles,
          turnstileSecret: "secret",
          log: () => {},
        });
      const web = yield* create();
      yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
      const ip = createHash("sha256").update("private-ip").digest("hex");
      yield* f.sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 29)
    INSERT INTO discovery_attempt SELECT ${ip}, 0 FROM n`;
      const responses = yield* Effect.promise(() =>
        Promise.all([web.handler(request(), context), web.handler(request(), context)]),
      );
      expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
        200, 429,
      ]);
      expect(yield* f.sql`SELECT COUNT(*) AS n FROM discovery_attempt`).toEqual([{ n: 30 }]);
      expect(yield* f.sql`SELECT COUNT(*) AS n FROM discovery_registration`).toEqual([{ n: 1 }]);
      const replacement = yield* create();
      yield* Effect.addFinalizer(() => Effect.promise(replacement.dispose));
      yield* TestClock.adjust("30 minutes");
      const limited = yield* Effect.promise(() => replacement.handler(request(), context));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).toBe("1800");
      yield* TestClock.adjust("30 minutes");
      expect((yield* Effect.promise(() => replacement.handler(request(), context))).status).toBe(
        200,
      );
      expect(yield* f.sql`SELECT COUNT(*) AS n FROM discovery_attempt`).toEqual([{ n: 1 }]);
      const plan =
        yield* f.sql`EXPLAIN QUERY PLAN SELECT COUNT(*), MIN(at) FROM discovery_attempt WHERE ip = ${ip} AND at > 0`;
      expect(JSON.stringify(plan)).toContain("discovery_attempt_ip");
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  ));
