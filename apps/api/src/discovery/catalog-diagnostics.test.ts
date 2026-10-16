import { expect, test } from "vitest";
import { contactCause } from "./diagnostics.ts";
import { catalogClient } from "../personas/catalog.ts";

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
