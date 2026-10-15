import { expect, test, vi } from "vitest";
import { applicationRequest } from "./application-request.ts";

test("request boundaries link child IDs, summarize statuses and redact failure payloads", async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const request = new Request("https://app.example/discovery/waitlist", {
      method: "POST",
      body: "private contact",
      headers: { Authorization: "Bearer private-secret" },
    });
    const child = "01234567-89ab-cdef-0123-456789abcdef";
    const ok = await applicationRequest(request, async (childRequest) => {
      expect(childRequest.headers.get("x-operation-id")).toMatch(/^[0-9a-f-]{36}$/);
      return new Response("ok", { headers: { "X-Request-ID": child } });
    });
    expect(ok.headers.get("x-request-id")).toBe(child);
    for (const status of [400, 503]) {
      const response = await applicationRequest(
        new Request("https://app.example"),
        async () => new Response(null, { status, headers: { "X-Request-ID": "invalid" } }),
      );
      expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    }
    const failed = await applicationRequest(new Request("https://app.example"), () =>
      Promise.reject(
        Object.assign(new Error("private contact and private-secret"), { code: "SQLITE_ERROR" }),
      ),
    );
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      error: "Application is unavailable",
      requestId: failed.headers.get("x-request-id"),
    });
    const logs = JSON.stringify([...stdout.mock.calls, ...stderr.mock.calls]);
    expect(logs).toContain("SQLITE_ERROR");
    expect(logs).not.toContain("private contact");
    expect(logs).not.toContain("private-secret");
    expect(logs).toContain(child);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
