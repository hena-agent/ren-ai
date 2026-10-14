import { expect, test, vi } from "vitest";
import { applicationTransport } from "./application-transport.ts";

test("initialization and transport failure retain correlation and safe cause without request data", async () => {
  const request = new Request("https://app.example", {
    headers: { Authorization: "Bearer private-credential" },
  });
  const ok = new Response("ready");
  expect(await applicationTransport(request, async () => ok)).toBe(ok);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const response = await applicationTransport(request, () =>
      Promise.reject(
        Object.assign(new Error("private-credential sensitive-data-marker"), {
          code: "DB_UNAVAILABLE",
        }),
      ),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Application is unavailable",
      requestId: response.headers.get("x-request-id"),
    });
    const logs = JSON.stringify(stderr.mock.calls);
    expect(logs).toContain("DB_UNAVAILABLE");
    expect(logs).not.toContain("private-credential");
    expect(logs).not.toContain("sensitive-data-marker");
  } finally {
    stderr.mockRestore();
  }
});
