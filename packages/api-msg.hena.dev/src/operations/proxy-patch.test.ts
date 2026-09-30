import { request } from "node:http";
import { expect, test } from "vitest";
import { proxyBoundary, proxyFixture } from "../../test/operations-proxy.test-helper.ts";
import { patchProxy } from "./proxy-patch.ts";

test("proxy patch fails closed on missing, duplicate, and already patched anchors", () => {
  expect(() => patchProxy("")).toThrow("Unrecognized");
  expect(() =>
    patchProxy(proxyFixture + '\n  headers.set("authorization", basicAuthHeader());'),
  ).toThrow("Unrecognized");
  expect(() => patchProxy(patchProxy(proxyFixture))).toThrow("Unrecognized");
  expect(patchProxy(proxyFixture)).not.toBe(proxyFixture);
  expect(patchProxy(proxyFixture)).toContain(
    "type WSData = { authorization: string; target: string;",
  );
});

test("native machine credentials never become cached privileged credentials, including websocket upgrades", async () => {
  const fixture = await proxyBoundary();
  try {
    expect((await fetch(fixture.url)).status).toBe(401);
    expect(fixture.received).toEqual([]);
    expect((await fetch(fixture.url, { headers: { cookie: "browser" } })).status).toBe(200);
    const valid = await fetch(fixture.url, { headers: { authorization: "Basic valid" } });
    expect(valid.status).toBe(200);
    const invalid = await fetch(fixture.url, {
      headers: { authorization: "Basic invalid", cookie: "browser" },
    });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("password-reads")).toBe("0");
    const bearer = await fetch(fixture.url, {
      headers: { authorization: "Bearer invalid", cookie: "browser" },
    });
    expect(bearer.status).toBe(401);
    expect(bearer.headers.get("password-reads")).toBe("0");
    expect(fixture.received).toEqual([
      { authorization: "Basic privileged", cookie: undefined, ws: false },
      { authorization: "Basic valid", cookie: undefined, ws: false },
      { authorization: "Basic invalid", cookie: undefined, ws: false },
      { authorization: "Bearer invalid", cookie: undefined, ws: false },
    ]);
    await new Promise<void>((resolve, reject) => {
      const req = request(fixture.url, {
        headers: {
          authorization: "Basic machine-ws",
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
        },
      });
      req.on("upgrade", (_res, socket) => {
        socket.on("data", () => {
          socket.destroy();
          resolve();
        });
      });
      req.on("error", reject);
      req.end();
    });
    expect(fixture.received.at(-1)).toEqual({
      authorization: "Basic machine-ws",
      cookie: undefined,
      ws: true,
    });
  } finally {
    await fixture.close();
  }
});
