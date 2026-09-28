import { createServer } from "node:http";
import { connect } from "node:net";
import { ConfigProvider, Effect } from "effect";
import { expect, test, vi } from "vitest";
import { serveViewer, viewerFront } from "./viewer.ts";

const auth = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;
const origin = "https://app.opencode.ai";

test("viewer forwards exactly the protected browse routes, never config or mutations", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>(async () => new Response("from host"));
  const viewer = viewerFront(web, "secret");
  for (const path of [
    "/api/info",
    "/api/project",
    "/api/location",
    "/api/session",
    "/api/session/ses_1",
    "/api/session/ses_1/message",
    "/api/session/ses_1/message/m_1",
    "/api/session/ses_1/inbox",
    "/api/event",
  ]) {
    const request = (authorization?: string) =>
      viewer(
        new Request(`http://localhost${path}`, { headers: { authorization: authorization ?? "" } }),
      );
    expect((await request()).status).toBe(401);
    expect((await request("Basic wrong")).status).toBe(401);
    expect(await (await request(auth)).text()).toBe("from host");
    expect(
      (
        await viewer(
          new Request(`http://localhost${path}/extra/more`, { headers: { authorization: auth } }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await viewer(
          new Request(`http://localhost/private${path}`, { headers: { authorization: auth } }),
        )
      ).status,
    ).toBe(403);
  }
  for (const path of [
    "/api/config",
    "/api/plugin",
    "/api/session/active",
    "/api/session/s_1/permission",
    "/api/session/s_1/form",
    "/api/session/s_1/diff",
    "/api/session/s_1/inbox/i_1",
    "/api/session/s_1/message/m_1/extra",
    "/api/session//message",
    "/openapi.json",
  ]) {
    expect(
      (await viewer(new Request(`http://localhost${path}`, { headers: { authorization: auth } })))
        .status,
    ).toBe(403);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
    expect(
      (
        await viewer(
          new Request("http://localhost/api/session", { method, headers: { authorization: auth } }),
        )
      ).status,
    ).toBe(403);
  }
  expect(web).toHaveBeenCalledTimes(9);
  expect(() => viewerFront(web, "")).toThrow(/password/);
});

test("only the web app origin can preflight permitted GET routes", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>(
    async () =>
      new Response("safe", {
        headers: { "X-Host": "present", "Access-Control-Allow-Origin": "*" },
      }),
  );
  const viewer = viewerFront(web, "secret");
  const request = (path: string, method: string, requestedMethod: string, requestOrigin = origin) =>
    viewer(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          origin: requestOrigin,
          "access-control-request-method": requestedMethod,
          authorization: auth,
        },
      }),
    );
  const preflight = await request("/api/event", "OPTIONS", "GET");
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
  expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
  expect(preflight.headers.get("access-control-allow-headers")).toContain("X-OpenCode-Directory");
  expect(preflight.headers.get("access-control-allow-methods")).toBe("GET");
  expect(preflight.headers.get("vary")).toBe("Origin");
  expect((await request("/api/config", "OPTIONS", "GET")).status).toBe(403);
  expect((await request("/api/event", "OPTIONS", "POST")).status).toBe(403);
  expect((await request("/api/event", "OPTIONS", "GET", "https://evil.example")).status).toBe(403);
  expect(
    (await request("/api/event", "OPTIONS", "GET", "https://evil.example")).headers.get(
      "access-control-allow-origin",
    ),
  ).toBeNull();
  const response = await request("/api/session", "GET", "GET");
  expect(response.headers.get("x-host")).toBe("present");
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  expect(
    (
      await viewer(
        new Request("http://localhost/api/session", {
          headers: { authorization: auth, origin: "https://evil.example" },
        }),
      )
    ).headers.get("access-control-allow-origin"),
  ).toBeNull();
  expect(
    (await viewer(new Request("http://localhost/api/session", { headers: { origin } }))).status,
  ).toBe(401);
  expect(web).toHaveBeenCalledTimes(2);
});

test("listener binds loopback, reads password from ConfigProvider and streams responses", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>(async (request: Request) => {
    if (request.url.endsWith("/api/event")) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: live\n\n"));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return new Response("live");
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveViewer(web, 0);
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP listener");
        expect(address.address).toBe("127.0.0.1");
        const base = `http://127.0.0.1:${address.port}`;
        expect((yield* Effect.promise(() => fetch(`${base}/api/info`))).status).toBe(401);
        expect(
          (yield* Effect.promise(() =>
            fetch(`${base}/api/config`, { headers: { authorization: auth } }),
          )).status,
        ).toBe(403);
        const response = yield* Effect.promise(() =>
          fetch(`${base}/api/event`, { headers: { authorization: auth } }),
        );
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        expect(yield* Effect.promise(() => response.text())).toBe("data: live\n\n");
        expect(web.mock.lastCall![0].signal.aborted).toBe(true);
        expect(web).toHaveBeenCalledTimes(1);
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              const socket = connect(address.port, "127.0.0.1");
              socket.once("error", reject);
              socket.once("data", () => {
                socket.destroy();
                resolve();
              });
              socket.write(
                `GET /api/info HTTP/1.1\r\nHost: localhost\r\nAuthorization: ${auth}\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n`,
              );
            }),
        );
        expect(web).toHaveBeenCalledTimes(2);
        expect(web.mock.lastCall![0].headers.get("set-cookie")).toBeNull();
      }),
    ).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ VIEWER_PASSWORD: "secret" })),
      ),
    ),
  );
  await expect(
    Effect.runPromise(
      Effect.scoped(serveViewer(web, 0)).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ VIEWER_PASSWORD: "" }))),
      ),
    ),
  ).rejects.toThrow(/VIEWER_PASSWORD/);
});

test("listener refuses occupied ports and closes failed host responses", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  const config = ConfigProvider.layer(ConfigProvider.fromUnknown({ VIEWER_PASSWORD: "secret" }));
  try {
    await expect(
      Effect.runPromise(
        Effect.scoped(serveViewer(async () => new Response(), address.port)).pipe(
          Effect.provide(config),
        ),
      ),
    ).rejects.toThrow(/Effect.tryPromise/);
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveViewer(
          () => Promise.reject(new Error("host failed")),
          address.port,
        );
        const response = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${address.port}/api/info`, {
            headers: { authorization: auth },
          }).catch((error: Error) => error),
        );
        expect(response).toBeInstanceOf(Error);
        expect(server.listening).toBe(true);
      }),
    ).pipe(Effect.provide(config)),
  );
});

test("stopping the viewer disconnects an open event stream", async () => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveViewer(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("data: live\n\n"));
                },
              }),
            ),
          0,
        );
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP listener");
        const response = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${address.port}/api/event`, {
            headers: { authorization: auth },
          }),
        );
        reader = response.body!.getReader();
        expect((yield* Effect.promise(() => reader!.read())).done).toBe(false);
      }),
    ).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ VIEWER_PASSWORD: "secret" })),
      ),
    ),
  );
  await expect(reader!.read()).rejects.toThrow(/terminated|aborted/i);
});
