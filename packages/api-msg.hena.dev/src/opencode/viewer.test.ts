import { createServer } from "node:http";
import { connect } from "node:net";
import { ConfigProvider, Effect } from "effect";
import { expect, test, vi } from "vitest";
import { serveViewer, viewerFront } from "./viewer.ts";

const auth = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;

test("browser login challenges the page and event stream before serving either", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>(
    async () => new Response("data: ready\n\n"),
  );
  const ui = vi.fn<(request: Request) => Promise<Response>>(
    async () => new Response("<html>OpenCode</html>"),
  );
  const viewer = viewerFront(web, "secret", ui);
  for (const path of ["/", "/connect", "/_assets/index.js", "/api/event"]) {
    for (const authorization of ["", "Basic wrong"]) {
      const response = await viewer(
        new Request(`http://localhost${path}`, { headers: { authorization } }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        'Basic realm="Persona viewer", charset="UTF-8"',
      );
    }
  }
  expect(web).not.toHaveBeenCalled();
  expect(ui).not.toHaveBeenCalled();
  const page = await viewer(new Request("http://localhost/", { headers: { authorization: auth } }));
  expect(await page.text()).toBe("<html>OpenCode</html>");
  const stream = await viewer(
    new Request("http://localhost/api/event", { headers: { authorization: auth } }),
  );
  expect(await stream.text()).toBe("data: ready\n\n");
});

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
    ).toBe(503);
    expect(
      (
        await viewer(
          new Request(`http://localhost/api/unexpected${path}`, {
            headers: { authorization: auth },
          }),
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
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
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

test("the same-origin V2 shell shares authentication, while the API denies CORS", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>(
    async () =>
      new Response("safe", {
        headers: { "X-Host": "present", "Access-Control-Allow-Origin": "*" },
      }),
  );
  const ui = vi.fn<(request: Request) => Promise<Response>>(
    async () =>
      new Response("<!doctype html><title>OpenCode V2</title>", {
        headers: { "Content-Type": "text/html" },
      }),
  );
  const viewer = viewerFront(web, "secret", ui);
  for (const path of [
    "/",
    "/connect",
    "/_assets/index.js",
    "/icons/prod/favicon.ico",
    "/server/key/session/ses_1",
  ]) {
    const response = await viewer(
      new Request(`http://localhost${path}`, { headers: { authorization: auth } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html");
  }
  for (const path of ["/api", "/api/config", "/openapi.json"]) {
    expect(
      (await viewer(new Request(`http://localhost${path}`, { headers: { authorization: auth } })))
        .status,
    ).toBe(403);
  }
  const preflight = await viewer(
    new Request("http://localhost/api/info", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    }),
  );
  expect(preflight.status).toBe(403);
  expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  const response = await viewer(
    new Request("http://localhost/api/session", {
      headers: { authorization: auth, origin: "https://evil.example" },
    }),
  );
  expect(response.headers.get("x-host")).toBe("present");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect((await viewer(new Request("http://localhost/api/session"))).status).toBe(401);
  expect(web).toHaveBeenCalledTimes(1);
  expect(ui).toHaveBeenCalledTimes(5);
});

test("without the isolated shell, the viewer fails closed on HTML routes", async () => {
  const viewer = viewerFront(async () => new Response("safe"), "secret");
  expect(
    (await viewer(new Request("http://localhost/", { headers: { authorization: auth } }))).status,
  ).toBe(503);
  expect(
    (await viewer(new Request("http://localhost/api/config", { headers: { authorization: auth } })))
      .status,
  ).toBe(403);
});

test("listener serves the isolated V2 shell at / but never forwards an API path to it", async () => {
  const shell = vi.fn<typeof fetch>((input) =>
    typeof input === "string" && input.endsWith("/unavailable")
      ? Promise.reject(new Error("isolated shell stopped"))
      : Promise.resolve(
          new Response("<!doctype html><title>OpenCode</title>", {
            headers: { "Content-Type": "text/html" },
          }),
        ),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const web = vi.fn<(request: Request) => Promise<Response>>(async () => new Response("API"));
        const server = yield* serveViewer(web, 0, shell);
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP listener");
        const base = `http://127.0.0.1:${address.port}`;
        expect(
          (yield* Effect.promise(() => fetch(base, { headers: { authorization: auth } }))).status,
        ).toBe(200);
        expect(
          (yield* Effect.promise(() =>
            fetch(`${base}/connect`, { headers: { authorization: auth } }),
          )).headers.get("content-type"),
        ).toBe("text/html");
        const unavailable = yield* Effect.promise(() =>
          fetch(`${base}/unavailable`, { headers: { authorization: auth } }),
        );
        expect(unavailable.status).toBe(502);
        expect(yield* Effect.promise(() => unavailable.text())).toBe("Web UI unavailable");
        expect(
          (yield* Effect.promise(() =>
            fetch(`${base}/api/info`, { headers: { authorization: auth } }),
          )).status,
        ).toBe(200);
        expect(web).toHaveBeenCalledTimes(1);
        expect(shell).toHaveBeenCalledTimes(3);
        expect(shell.mock.calls[0]![1]?.headers).toEqual({ "Accept-Encoding": "identity" });
      }),
    ).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ VIEWER_PASSWORD: "secret" })),
      ),
    ),
  );
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
