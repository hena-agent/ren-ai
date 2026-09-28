import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Config, Effect } from "effect";

const origin = "https://app.opencode.ai";
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
export const viewerFront = (web: (request: Request) => Promise<Response>, password: string) => {
  if (!password) throw new Error("Viewer password must not be empty");
  const expected = createHash("sha256")
    .update(`Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`)
    .digest();
  return (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const trustedOrigin = request.headers.get("origin") === origin;
    const headers = trustedOrigin
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Headers": "Authorization, Content-Type, X-OpenCode-Directory",
          "Access-Control-Allow-Methods": "GET",
          Vary: "Origin",
        }
      : {};
    // Browsers preflight credentialed GETs without sending credentials. Never forward OPTIONS.
    if (request.method === "OPTIONS") {
      return Promise.resolve(
        new Response(null, {
          status:
            trustedOrigin &&
            allowed(path) &&
            request.headers.get("access-control-request-method") === "GET"
              ? 204
              : 403,
          headers,
        }),
      );
    }
    const authorization = request.headers.get("authorization");
    if (!authorization) return Promise.resolve(new Response(null, { status: 401, headers }));
    const actual = createHash("sha256").update(authorization).digest();
    if (!timingSafeEqual(actual, expected)) {
      return Promise.resolve(new Response(null, { status: 401, headers }));
    }
    if (request.method !== "GET" || !allowed(path)) {
      return Promise.resolve(new Response(null, { status: 403, headers }));
    }
    return web(request).then((response) => {
      const output = new Response(response.body, response);
      output.headers.delete("access-control-allow-origin");
      for (const [name, value] of Object.entries(headers)) output.headers.set(name, value);
      return output;
    });
  };
};

/** The viewer is the only listener for the host handler; it binds to loopback for Tailscale Serve. */
export const serveViewer = (web: (request: Request) => Promise<Response>, port: number) =>
  Effect.gen(function* () {
    const password = yield* Config.string("VIEWER_PASSWORD");
    const front = viewerFront(web, password);
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
