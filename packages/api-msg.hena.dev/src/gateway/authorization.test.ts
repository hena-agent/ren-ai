import { Effect } from "effect";
import { expect, test } from "vitest";
import { gatewayFixture } from "../../test/gateway.test-helper.ts";
import { messageGateway } from "./server.ts";

test("messaging authorization fails closed for absent configuration and invalid credentials", async () => {
  const fixture = gatewayFixture();
  try {
    expect(() => messageGateway(fixture.local.messages, "", fixture.gestures.gestures)).toThrow(
      "Service authorization token is required",
    );
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
