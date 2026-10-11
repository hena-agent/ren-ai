import { expect, test, vi } from "vitest";
import { adminRequest } from "./admin-request.ts";

test("initialization and transport failures have safe structured diagnostics and server-generated request IDs", async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const request = new Request("https://admin.test/new", {
    headers: { "x-request-id": "client-controlled" },
  });
  const original = new Response("ok");
  expect(await adminRequest(request, async () => original)).toBe(original);
  const response = await adminRequest(request, async () => {
    throw Object.assign(new Error("private draft or credential payload"), { code: "ECONNREFUSED" });
  });
  expect(response.status).toBe(503);
  const id = response.headers.get("x-request-id")!;
  expect(id).not.toBe("client-controlled");
  expect(await response.text()).toContain(id);
  const diagnostic = stderr.mock.calls.map(([line]) => String(line)).join("");
  expect(diagnostic).toContain(id);
  expect(diagnostic).toContain('"stage":"admin.runtime"');
  expect(diagnostic).toContain('"causeCode":"ECONNREFUSED"');
  expect(diagnostic).not.toContain("private draft or credential payload");
  stdout.mockRestore();
  stderr.mockRestore();
});
