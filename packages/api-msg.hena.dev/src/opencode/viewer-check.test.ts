import { expect, test, vi } from "vitest";
import { expectViewerMutationsDenied, expectViewerRead } from "./viewer-check.test-helper.ts";

test("viewer read checks reject wrong status, leaked details and incorrect data independently", async () => {
  for (const { status, body, expected } of [
    { status: 201, body: { name: "safe" }, expected: { name: "safe" } },
    { status: 200, body: { name: "private" }, expected: { name: "private" } },
    { status: 200, body: { name: "wrong" }, expected: { name: "safe" } },
  ]) {
    await expect(
      expectViewerRead(
        async (request) =>
          request.headers.has("authorization")
            ? Response.json(body, { status })
            : new Response(null, { status: 401 }),
        "/api/example",
        "Basic test",
        expected,
        "private",
      ),
    ).rejects.toThrow(/expected/);
  }
});

test("mutation checks exercise every route with authentication and reject successful writes", async () => {
  const viewer = vi.fn<(request: Request) => Promise<Response>>(
    async () => new Response(null, { status: 403 }),
  );
  await expectViewerMutationsDenied(viewer, ["/api/first", "/api/second"], "Basic test");
  expect(
    viewer.mock.calls.map(([request]) => ({
      path: new URL(request.url).pathname,
      method: request.method,
      authorization: request.headers.get("authorization"),
    })),
  ).toEqual([
    { path: "/api/first", method: "POST", authorization: "Basic test" },
    { path: "/api/second", method: "POST", authorization: "Basic test" },
  ]);
  viewer.mockResolvedValue(new Response(null, { status: 200 }));
  await expect(expectViewerMutationsDenied(viewer, ["/api/first"], "Basic test")).rejects.toThrow(
    /expected/,
  );
});
