import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { contactManagement } from "./management.ts";
import { contactCause, contactLog } from "./diagnostics.ts";
import type { ContactDiagnostic } from "./diagnostics.ts";
import { contacts } from "./contacts.ts";
import { contactFixture, withContactDatabase } from "./contact.test-helper.ts";

test("authenticated management validates, lists, selects and safely correlates failures", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      yield* f.register("private@example.net");
      const logs: ContactDiagnostic[] = [];
      const handler = contactManagement(f.store, "private-admin-token", (entry) =>
        logs.push(entry),
      );
      const parent = randomUUID();
      const call = (path: string, method = "GET", body?: string, token = "private-admin-token") =>
        handler(
          new Request(`https://api.test${path}`, {
            method,
            headers: { Authorization: `Bearer ${token}`, "X-Operation-ID": parent },
            ...(body && { body }),
          }),
        );
      yield* Effect.promise(async () => {
        expect((await call("/management/discovery", "GET", undefined, "wrong")).status).toBe(401);
        expect((await handler(new Request("https://api.test/management/discovery"))).status).toBe(
          401,
        );
        expect(
          (
            await handler(
              new Request("https://api.test/management/discovery", {
                headers: { "X-Operation-ID": "private@example.net" },
              }),
            )
          ).status,
        ).toBe(401);
        expect((await call("/unknown")).status).toBe(404);
        expect((await call("/management/discovery", "DELETE")).status).toBe(404);
        const list = await call("/management/discovery");
        expect(await list.json()).toMatchObject({ eligibleCount: 1 });
        for (const body of [
          "not-json private@example.net",
          JSON.stringify({ requestId: randomUUID(), count: 0 }),
        ]) {
          const invalid = await call("/management/discovery/select", "POST", body);
          expect(invalid.status).toBe(400);
          expect(await invalid.json()).toHaveProperty(
            "requestId",
            invalid.headers.get("x-request-id"),
          );
        }
        const input = { requestId: randomUUID(), count: 1 };
        const selection = await call("/management/discovery/select", "POST", JSON.stringify(input));
        expect(await selection.json()).toMatchObject({
          requested: 1,
          entries: [{ state: "scheduled" }],
        });
        expect(
          (
            await call(
              "/management/discovery/select",
              "POST",
              JSON.stringify({ ...input, count: 2 }),
            )
          ).status,
        ).toBe(409);
        const denied = await contactManagement(f.store, "", (entry) => logs.push(entry))(
          new Request("https://api.test/management/discovery"),
        );
        expect(denied.status).toBe(401);
        const snapshot = JSON.stringify(logs);
        expect(snapshot).not.toContain("private@example.net");
        expect(snapshot).not.toContain("private-admin-token");
        expect(
          logs.some((entry) => entry.stage === "selection.commit" && entry.outcome === "failed"),
        ).toBe(true);
        expect(logs.every((entry) => entry.requestId && entry.durationMs >= 0)).toBe(true);
        expect(logs.some((entry) => entry.operationId === parent)).toBe(true);
      });
      const offline = yield* contacts(async () => {
        throw new Error("private provider payload");
      });
      const handlerOffline = contactManagement(offline, "private-admin-token", (entry) =>
        logs.push(entry),
      );
      yield* Effect.promise(async () =>
        expect(
          (
            await handlerOffline(
              new Request("https://api.test/management/discovery", {
                headers: { Authorization: "Bearer private-admin-token" },
              }),
            )
          ).status,
        ).toBe(503),
      );
    }),
  );
});

test("management starts a test handle now, refusing other handles with a correlated conflict", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      const tester = yield* f.register("tester@example.net");
      const stranger = yield* f.register("stranger@example.net", ["harin"]);
      yield* f.sql`INSERT INTO test_handle VALUES ('tester@example.net')`;
      const logs: ContactDiagnostic[] = [];
      const handler = contactManagement(f.store, "private-admin-token", (entry) =>
        logs.push(entry),
      );
      const start = (body: object | string) =>
        handler(
          new Request("https://api.test/management/discovery/start", {
            method: "POST",
            headers: { Authorization: "Bearer private-admin-token" },
            body: typeof body === "string" ? body : JSON.stringify(body),
          }),
        );
      yield* Effect.promise(async () => {
        const unknown = await handler(
          new Request("https://api.test/management/discovery/other", {
            method: "POST",
            headers: { Authorization: "Bearer private-admin-token" },
          }),
        );
        expect(unknown.status).toBe(404);
        expect((await start("not-json")).status).toBe(400);
        expect((await start({ requestId: randomUUID(), registrationID: tester })).status).toBe(400);
        const refused = await start({
          requestId: randomUUID(),
          registrationID: stranger,
          personaID: "harin",
        });
        expect(refused.status).toBe(409);
        expect(await refused.json()).toEqual({
          error: "start_unavailable",
          requestId: refused.headers.get("x-request-id"),
        });
        const started = await start({
          requestId: randomUUID(),
          registrationID: tester,
          personaID: "luna",
        });
        expect(started.status).toBe(200);
        expect(await started.json()).toMatchObject({
          requested: 1,
          entries: [{ id: tester, state: "scheduled", testHandle: true }],
        });
      });
      yield* f.sql`CREATE TRIGGER fail_selection BEFORE INSERT ON discovery_selection BEGIN SELECT RAISE(ABORT, 'fail'); END`;
      yield* f.sql`DELETE FROM discovery_contact`;
      yield* f.sql`DELETE FROM persona_assignment`;
      yield* Effect.promise(async () => {
        const failed = await start({
          requestId: randomUUID(),
          registrationID: tester,
          personaID: "luna",
        });
        expect(failed.status).toBe(503);
        expect(await failed.json()).toHaveProperty("error", "start_failed");
      });
      expect(
        logs
          .filter((entry) => entry.outcome === "failed")
          .map((entry) => [entry.stage, entry.code]),
      ).toEqual([
        ["authorization", "not_found"],
        ["start.input", "invalid_request"],
        ["start.input", "invalid_request"],
        ["start.commit", "start_unavailable"],
        ["start.commit", "start_failed"],
      ]);
      expect(JSON.stringify(logs)).not.toContain("tester@example.net");
    }),
  );
});

test("direct selection validates explicit targets instead of falling back to random selection", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      const selected = yield* f.register("chosen@example.net");
      yield* f.register("other@example.net", ["harin"]);
      const handler = contactManagement(f.store, "secret", () => {});
      const call = (registrationIDs?: readonly string[]) =>
        handler(
          new Request("https://api.test/management/discovery/select-specific", {
            method: "POST",
            headers: { Authorization: "Bearer secret" },
            body: JSON.stringify({
              requestId: randomUUID(),
              count: 1,
              ...(registrationIDs && { registrationIDs }),
            }),
          }),
        );
      yield* Effect.promise(async () => {
        for (const ids of [undefined, [], ["bad"], [selected, selected]])
          expect((await call(ids)).status).toBe(400);
        const result = await call([selected]);
        expect(result.status).toBe(200);
        expect(await result.json()).toMatchObject({
          requested: 1,
          entries: [{ id: selected, state: "scheduled" }],
        });
      });
      expect(yield* f.sql`SELECT * FROM discovery_contact`).toHaveLength(1);
    }),
  );
});

test("runtime diagnostics emit JSON and narrow non-Error and unsafe provider metadata", () => {
  expect(contactCause("private payload").causeName).toBe("Error");
  expect(typeof contactCause("private payload").stack).toBe("string");
  expect(
    contactCause(Object.assign(new Error("secret"), { code: "private@example.net" })),
  ).not.toHaveProperty("causeCode");
  expect(contactCause(Object.assign(new Error("secret"), { code: 500 }))).not.toHaveProperty(
    "causeCode",
  );
  const noStack = new Error("private payload");
  delete noStack.stack;
  expect(contactCause(noStack).stack).toBe("");
  const event: ContactDiagnostic = {
    requestId: "id",
    operation: "test",
    stage: "request",
    outcome: "completed",
    level: "info",
    durationMs: 0,
  };
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    contactLog(event);
    contactLog({ ...event, level: "error", outcome: "failed" });
    expect(stdout).toHaveBeenCalledWith(`${JSON.stringify(event)}\n`);
    expect(stderr).toHaveBeenCalledWith(
      `${JSON.stringify({ ...event, level: "error", outcome: "failed" })}\n`,
    );
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
