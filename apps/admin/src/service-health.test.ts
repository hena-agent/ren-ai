import { expect, test, vi } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { adminHealth } from "./service-health.ts";

test("Admin health identifies the service and correlates safe database failure diagnostics", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const first = vi.fn<D1PreparedStatement["first"]>().mockResolvedValue(1);
  const env = {
    DB: fromPartial<D1Database>({ prepare: () => fromPartial<D1PreparedStatement>({ first }) }),
  };
  try {
    const ready = await adminHealth(new Request("https://admin.test/health"), env);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      service: "admin",
      revision: "development",
      status: "ready",
      database: "ready",
    });
    expect(ready.headers.get("cache-control")).toBe("no-store");
    const methodNotAllowed = await adminHealth(
      new Request("https://admin.test/health", { method: "POST" }),
      env,
    );
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get("cache-control")).toBe("no-store");
    first.mockRejectedValueOnce(
      Object.assign(new Error("private SQL payload secret"), { code: "SQLITE_ERROR" }),
    );
    const failure = await adminHealth(new Request("https://admin.test/health"), env);
    expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({
      service: "admin",
      revision: "development",
      status: "degraded",
      database: "unavailable",
    });
    const logs = JSON.stringify(stderr.mock.calls);
    expect(logs).toContain(failure.headers.get("x-request-id"));
    expect(logs).toContain("health.database");
    expect(logs).toContain("SQLITE_ERROR");
    expect(logs).not.toContain("private SQL payload secret");
  } finally {
    vi.restoreAllMocks();
  }
});
