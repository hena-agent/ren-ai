import { afterEach, expect, test, vi } from "vitest";
import { waitForHealth } from "./health-rollout.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const expected = { service: "admin", revision: "a".repeat(40), status: "ready" };

test("rollout waits for the exact revision and real readiness, reporting only allowlisted metadata", async () => {
  vi.useFakeTimers();
  const logs = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ ...expected, revision: "b".repeat(40), private: "private-marker" }),
    )
    .mockResolvedValueOnce(Response.json({ ...expected, status: "degraded" }, { status: 503 }))
    .mockResolvedValueOnce(Response.json(expected));
  const pending = waitForHealth("https://admin.test", "admin", expected.revision, false, fetcher);
  const timers = vi.runAllTimersAsync();
  await expect(pending).resolves.toEqual(expected);
  await timers;
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: "manual", cache: "no-store" });
  expect(JSON.stringify(logs.mock.calls)).toContain("b".repeat(40));
  expect(JSON.stringify(logs.mock.calls)).not.toContain("private-marker");
});

test("unreachable and invalid endpoints stop after ninety-six probes without leaking upstream content", async () => {
  vi.useFakeTimers();
  const logs = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private response body"));
  fetcher.mockRejectedValueOnce(new Error("private secret"));
  const pending = waitForHealth("https://admin.test", "admin", expected.revision, false, fetcher);
  const timers = vi.runAllTimersAsync();
  await expect(pending).rejects.toThrow("timed out");
  await timers;
  expect(fetcher).toHaveBeenCalledTimes(96);
  expect(logs).toHaveBeenCalledTimes(96);
  expect(JSON.stringify(logs.mock.calls)).not.toContain("private");
});

test("identity-only Worker rollout can report degraded dependencies explicitly", async () => {
  const health = { ...expected, status: "degraded" };
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(Response.json(health, { status: 503 })),
  );
  expect(await waitForHealth("https://admin.test", "admin", expected.revision, true)).toEqual(
    health,
  );
});
