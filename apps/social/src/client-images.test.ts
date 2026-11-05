import { expect, test, vi } from "vitest";
import { socialApplication } from "./client.ts";

test("image previews, phase checkpoints and completion diagnostics use finite authenticated requests", async () => {
  const requests: Request[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return request.url.endsWith("/image")
      ? Response.json({ id: "draft", data: "/9j/2Q==", mime: "image/jpeg" })
      : new Response(null, { status: 204 });
  });
  const client = socialApplication("https://api.test", "secret", fetcher);
  expect((await client.image("run", "draft")).id).toBe("draft");
  const diagnostic = {
    requestId: "request",
    stage: "model" as const,
    submission: "not_attempted" as const,
    code: "MODEL_FAILED",
    at: 1,
    durationMs: 1,
  };
  await client.progress("run", 0, diagnostic);
  await client.complete("run", "failed", diagnostic);
  expect(await requests[1]!.json()).toEqual({ runId: "run", step: 0, diagnostic });
  expect(await requests[2]!.json()).toEqual({ runId: "run", state: "failed", diagnostic });
  expect(
    requests.every((request) => request.headers.get("Authorization") === "Bearer secret"),
  ).toBe(true);
  fetcher.mockResolvedValue(
    new Response(null, {
      status: 503,
      headers: { "X-Request-ID": "10000000-0000-4000-8000-000000000001" },
    }),
  );
  await expect(client.control("run")).rejects.toMatchObject({
    upstreamStatus: 503,
    requestId: "10000000-0000-4000-8000-000000000001",
  });
});
