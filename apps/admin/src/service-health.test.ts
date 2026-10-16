import { expect, test, vi } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import { adminHealth } from "./service-health.ts";
import type { AdminEnv } from "./cloudflare-admin.ts";

const env = (first: () => Promise<null>) =>
  fromPartial<Pick<AdminEnv, "DB">>({ DB: { prepare: () => ({ first }) } });

test("admin health reports readiness and rejects non-GET requests without touching storage", async () => {
  const ready = await adminHealth(
    new Request("https://admin.test/health"),
    env(async () => null),
  );
  expect(ready.status).toBe(200);
  expect(ready.headers.get("cache-control")).toBe("no-store");
  expect(await ready.json()).toEqual({
    service: "admin",
    revision: "development",
    status: "ready",
    database: "ready",
  });
  const first = vi.fn<() => Promise<null>>(async () => null);
  const rejected = await adminHealth(
    new Request("https://admin.test/health", { method: "POST" }),
    env(first),
  );
  expect(rejected.status).toBe(405);
  expect(rejected.headers.get("allow")).toBe("GET");
  expect(first).not.toHaveBeenCalled();
});

test("admin health logs database failure and returns a safe degraded response", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const failure = await adminHealth(
      new Request("https://admin.test/health"),
      env(() => Promise.reject(new Error("private-db-detail"))),
    );
    expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({
      service: "admin",
      revision: "development",
      status: "degraded",
      database: "unavailable",
    });
    expect(JSON.stringify(stderr.mock.calls)).toContain("database_unavailable");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("private-db-detail");
  } finally {
    stderr.mockRestore();
  }
});
