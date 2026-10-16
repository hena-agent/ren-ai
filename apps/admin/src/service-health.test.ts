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
    const editor = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const ready = await adminHealth(new Request("https://admin.test/health"), env, editor);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      service: "admin",
      revision: "development",
      status: "ready",
      database: "ready",
      editor: "ready",
    });
    expect(ready.headers.get("cache-control")).toBe("no-store");
    const methodNotAllowed = await adminHealth(
      new Request("https://admin.test/health", { method: "POST" }),
      env,
      editor,
    );
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get("cache-control")).toBe("no-store");
    first.mockRejectedValueOnce(
      Object.assign(new Error("private SQL payload secret"), { code: "SQLITE_ERROR" }),
    );
    const failure = await adminHealth(new Request("https://admin.test/health"), env, editor);
    expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({
      service: "admin",
      revision: "development",
      status: "degraded",
      database: "unavailable",
      editor: "ready",
    });
    const logs = JSON.stringify(stderr.mock.calls);
    expect(logs).toContain(failure.headers.get("x-request-id"));
    expect(logs).toContain("health.database");
    expect(logs).toContain("SQLITE_ERROR");
    expect(logs).not.toContain("private SQL payload secret");
    editor.mockRejectedValueOnce(
      Object.assign(new Error("private draft payload"), { code: "EDITOR_INIT" }),
    );
    const unavailable = await adminHealth(new Request("https://admin.test/health"), env, editor);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      database: "ready",
      editor: "unavailable",
      status: "degraded",
    });
    const diagnostics = JSON.stringify(stderr.mock.calls);
    expect(diagnostics).toContain(unavailable.headers.get("x-request-id"));
    expect(diagnostics).toContain("EDITOR_INIT");
    expect(diagnostics).not.toContain("private draft payload");
    editor.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await adminHealth(new Request("https://admin.test/health"), env, editor)).status).toBe(
      503,
    );
  } finally {
    vi.restoreAllMocks();
  }
});
