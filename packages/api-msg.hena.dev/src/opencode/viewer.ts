import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Config, Effect } from "effect";

const paths = [
  /^\/api\/info$/,
  /^\/api\/project$/,
  /^\/api\/location$/,
  /^\/api\/session$/,
  /^\/api\/session\/ses_[a-zA-Z0-9]+$/,
  /^\/api\/session\/ses_[a-zA-Z0-9]+\/message$/,
  /^\/api\/session\/ses_[a-zA-Z0-9]+\/message\/[^/]+$/,
  /^\/api\/session\/ses_[a-zA-Z0-9]+\/inbox$/,
  /^\/api\/event$/,
];

const allowed = (path: string) => paths.some((pattern) => pattern.test(path));

/** The raw host handler must never be exposed directly: GET /api/config contains provider keys. */
export const viewerFront = (
  web: (request: Request) => Promise<Response>,
  password: string,
  ui?: (request: Request) => Promise<Response>,
) => {
  if (!password) throw new Error("Viewer password must not be empty");
  const expected = createHash("sha256")
    .update(`Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`)
    .digest();
  return (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    // The official V2 app is same-origin; it needs no CORS access to the API.
    if (request.method !== "GET") return Promise.resolve(new Response(null, { status: 403 }));
    if (path !== "/api" && !path.startsWith("/api/") && path !== "/openapi.json") {
      return ui ? ui(request) : Promise.resolve(new Response(null, { status: 503 }));
    }
    const authorization = request.headers.get("authorization");
    if (!authorization) return Promise.resolve(new Response(null, { status: 401 }));
    const actual = createHash("sha256").update(authorization).digest();
    if (!timingSafeEqual(actual, expected)) {
      return Promise.resolve(new Response(null, { status: 401 }));
    }
    if (!allowed(path)) {
      return Promise.resolve(new Response(null, { status: 403 }));
    }
    return web(request).then((response) => {
      const output = new Response(response.body, response);
      output.headers.delete("access-control-allow-origin");
      output.headers.delete("access-control-allow-credentials");
      return output;
    });
  };
};

/** The viewer is the only listener for the host handler; it binds to loopback for Tailscale Serve. */
export const serveViewer = (
  web: (request: Request) => Promise<Response>,
  port: number,
  fetchAssets: typeof fetch = fetch,
) =>
  Effect.gen(function* () {
    const password = yield* Config.string("VIEWER_PASSWORD");
    // The isolated CLI serves only immutable V2 app assets here. Its API is never proxied.
    const front = viewerFront(web, password, (request) =>
      fetchAssets(`http://127.0.0.1:47987${new URL(request.url).pathname}`, {
        headers: { "Accept-Encoding": "identity" },
        signal: request.signal,
      }).catch(() => new Response("Web UI unavailable", { status: 502 })),
    );
    return yield* Effect.acquireRelease(
      Effect.tryPromise(
        () =>
          new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
            const server = createServer((incoming, outgoing) => {
              const controller = new AbortController();
              outgoing.on("close", () => controller.abort());
              const headers = new Headers();
              for (const [name, value] of Object.entries(incoming.headers)) {
                if (typeof value === "string") headers.set(name, value);
              }
              const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
                method: incoming.method!,
                headers,
                signal: controller.signal,
              });
              void front(request)
                .then(async (response) => {
                  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
                  if (response.body) {
                    for await (const chunk of response.body) {
                      outgoing.write(chunk);
                    }
                  }
                  return outgoing.end();
                })
                .catch(() => outgoing.destroy());
            });
            server.once("error", reject);
            server.listen(port, "127.0.0.1", () => resolve(server));
          }),
      ),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
    );
  });
