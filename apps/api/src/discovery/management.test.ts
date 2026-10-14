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
        ).toBe(503);
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
