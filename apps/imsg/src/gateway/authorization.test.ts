import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { gatewayFixture } from "../../test/gateway.test-helper.ts";
import { messageGateway } from "./server.ts";

const healthRequest = (method = "GET", token = "secret") =>
  new Request("https://imsg.test/health", {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });

test("messaging authorization fails closed for absent configuration and invalid credentials", async () => {
  const fixture = gatewayFixture();
  try {
    expect(() =>
      messageGateway(fixture.local.messages, "", fixture.gestures.gestures, fixture.notifications),
    ).toThrow("Service authorization token is required");
    for (const authorization of ["Bearer wrong", "Basic secret", "Bearer secreu"]) {
      const denied = await fixture.server.handler(
        new Request("https://imsg.test/rpc", { method: "POST", headers: { authorization } }),
      );
      expect(denied.status).toBe(401);
      expect(await denied.text()).toBe("Unauthorized");
    }
    fixture.transport.fetch = (request) => {
      const headers = new Headers(request.headers);
      headers.set("authorization", "Bearer wrong");
      return fixture.server.handler(new Request(request, { headers }));
    };
    await fixture.run((remote) =>
      Effect.gen(function* () {
        expect(
          yield* remote.sendText("+821012345678", "unauthorized").pipe(Effect.flip),
        ).toBeInstanceOf(Error);
        expect(fixture.local.bubbles).toEqual([]);
      }),
    );
  } finally {
    await fixture.server.dispose();
  }
});

test("permission verification reports a denied Mac UI permission", async () => {
  const fixture = gatewayFixture();
  fixture.gestures.gestures.probe = () => Effect.fail(new Error("Accessibility denied"));
  try {
    await fixture.run((remote) =>
      Effect.gen(function* () {
        expect((yield* remote.probe().pipe(Effect.flip)).message).toBe(
          "Error: Accessibility denied",
        );
        expect(fixture.local.bubbles).toEqual([]);
      }),
    );
  } finally {
    await fixture.server.dispose();
  }
});

test("HTTP health preserves authorization and reports identity and no-send readiness", async () => {
  const f = gatewayFixture();
  const history = vi.spyOn(f.local.messages, "after");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const unauthorized = await f.server.handler(healthRequest("GET", "wrong"));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe("no-store");
    expect(unauthorized.headers.get("x-request-id")).not.toBeNull();
    expect(JSON.stringify(stderr.mock.calls)).toContain("authorization");
    const methodNotAllowed = await f.server.handler(healthRequest("POST"));
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get("cache-control")).toBe("no-store");
    const response = await f.server.handler(healthRequest());
    expect(history).toHaveBeenCalledExactlyOnceWith(0, 1);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      service: "imsg",
      revision: "development",
      status: "ready",
      dependencies: { messages: "ready", notifications: "ready" },
    });
    f.gestures.gestures.probe = () =>
      Effect.fail(
        Object.assign(new Error("private permission detail"), { code: "PERMISSION_DENIED" }),
      );
    const failed = await f.server.handler(healthRequest());
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      service: "imsg",
      revision: "development",
      status: "degraded",
      dependencies: { messages: "degraded", notifications: "ready" },
    });
    expect(JSON.stringify(stderr.mock.calls)).toContain(failed.headers.get("x-request-id"));
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("private permission detail");
    expect(JSON.stringify(stderr.mock.calls)).toContain("PERMISSION_DENIED");
    for (const code of [123, "private-code-marker"]) {
      f.gestures.gestures.probe = () =>
        Effect.fail(Object.assign(new Error("private failure"), { code }));
      expect((await f.server.handler(healthRequest())).status).toBe(503);
    }
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("private-code-marker");
    f.gestures.gestures.probe = () => Effect.never;
    expect((await f.server.handler(healthRequest())).status).toBe(503);
    expect(f.local.bubbles).toEqual([]);
  } finally {
    stderr.mockRestore();
    await f.server.dispose();
  }
});
