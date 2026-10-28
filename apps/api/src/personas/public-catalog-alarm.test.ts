import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect, test } from "vitest";
import { metricsFixture } from "../../test/metrics-http.test-helper.ts";
import { captureDiagnostics } from "../../test/diagnostics.test-helper.ts";
import { applicationWakes } from "../scheduling.ts";
import { reloadPublicCatalog } from "./public-catalog.ts";

test("store Catalog maintenance logs failure, backs off independently, and Admin changes override its retry", async () => {
  const f = await metricsFixture();
  const diagnostics = captureDiagnostics();
  try {
    await f.store.catalogTick("catalog-first");
    expect(f.catalog).toHaveBeenCalledOnce();
    await f.store.catalogTick("catalog-idle");
    expect(f.catalog).toHaveBeenCalledOnce();
    f.catalog.mockRejectedValue(
      Object.assign(new Error("private upstream payload"), {
        code: "CATALOG_HTTP",
        upstreamStatus: 503,
      }),
    );
    await f.store.run(reloadPublicCatalog);
    await f.store.catalogTick("catalog-failed");
    const diagnostic = diagnostics.logs.join("");
    expect(diagnostic).toContain('"requestId":"catalog-failed"');
    expect(diagnostic).toContain('"stage":"refresh"');
    expect(diagnostic).toContain('"causeCode":"CATALOG_HTTP"');
    expect(diagnostic).toContain('"upstreamStatus":503');
    expect(diagnostic).not.toContain("private upstream payload");
    await f.store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM application_work WHERE name = 'public-catalog'`;
        const [retry] = yield* sql<{
          due: number;
        }>`SELECT due FROM application_work WHERE name = 'lane:catalog.cursor:refresh'`;
        const wakes = yield* applicationWakes;
        expect(wakes.store).toBeLessThanOrEqual(retry!.due);
        expect(wakes.execution).toBe(Number.POSITIVE_INFINITY);
      }),
    );
    await f.store.catalogTick("catalog-backoff");
    expect(f.catalog).toHaveBeenCalledTimes(2);
    f.catalog.mockResolvedValue([]);
    await f.store.run(reloadPublicCatalog);
    await f.store.catalogTick("catalog-updated");
    expect(f.catalog).toHaveBeenCalledTimes(3);
    const response = await f.store.handler(new Request("https://app/discovery/personas?locale=ko"));
    expect(await response.json()).toEqual({ people: [], nextCursor: null });
    expect(f.catalog).toHaveBeenCalledTimes(3);
  } finally {
    diagnostics.restore();
    await f.close();
  }
});
