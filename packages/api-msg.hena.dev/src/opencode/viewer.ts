import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Location } from "@opencode/schema/location";
import { Mcp } from "@opencode/schema/mcp";
import { Plugin } from "@opencode/schema/plugin";
import { Skill } from "@opencode/schema/skill";
import { Config, Effect, Schema } from "effect";

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

const extensions = new Set(["/api/mcp", "/api/plugin", "/api/skill"]);
const pluginName = /^(?:@[a-z\d][\w.-]*\/)?[a-z\d][\w.-]*$/i;

const extensionResponse = async (path: string, response: Response): Promise<Response> => {
  if (!response.ok) return new Response(null, { status: response.status });
  try {
    const body = await response.json();
    if (path === "/api/mcp") {
      const { location, data } = Schema.decodeUnknownSync(
        Location.response(Schema.Array(Mcp.Server)),
      )(body);
      return Response.json({
        location,
        data: data.map(({ name, status }) => ({
          name,
          status:
            status.status === "failed" || status.status === "needs_auth"
              ? { status: status.status, error: "Details hidden" }
              : { status: status.status },
        })),
      });
    }
    if (path === "/api/plugin") {
      const { location, data } = Schema.decodeUnknownSync(
        Location.response(Schema.Array(Plugin.Info)),
      )(body);
      return Response.json({
        location,
        data: data.map(({ id, source, state }) => ({
          ...(id && pluginName.test(id) ? { id } : {}),
          source:
            source.type === "local"
              ? { type: "local", path: "/" }
              : source.type === "package"
                ? {
                    type: "package",
                    target: pluginName.test(source.target) ? source.target : "package",
                  }
                : { type: source.type },
          features: {},
          state:
            state.status === "failed"
              ? { status: "failed", error: "Details hidden" }
              : { status: "active" },
        })),
      });
    }
    const { location, data } = Schema.decodeUnknownSync(
      Location.response(Schema.Array(Skill.Info)),
    )(body);
    return Response.json({
      location,
      data: data.map(({ id, name }) => ({ id, name, path: "/", content: "" })),
    });
  } catch {
    return new Response(null, { status: 502 });
  }
};

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
    const url = new URL(request.url);
    const path = url.pathname;
    // The official V2 app is same-origin; it needs no CORS access to the API.
    if (request.method !== "GET") return Promise.resolve(new Response(null, { status: 403 }));
    const authorization = request.headers.get("authorization");
    if (
      !authorization ||
      !timingSafeEqual(createHash("sha256").update(authorization).digest(), expected)
    ) {
      return Promise.resolve(
        new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="Persona viewer", charset="UTF-8"' },
        }),
      );
    }
    // Challenge navigation too: browser authentication then covers same-origin event requests.
    if (path !== "/api" && !path.startsWith("/api/") && path !== "/openapi.json") {
      return ui ? ui(request) : Promise.resolve(new Response(null, { status: 503 }));
    }
    if (extensions.has(path)) {
      // Only the default location: an arbitrary location would scan another directory for skills.
      if (
        [...url.searchParams].some(([key, value]) => key !== "location[directory]" || value !== "")
      ) {
        return Promise.resolve(new Response(null, { status: 403 }));
      }
      const headers = new Headers(request.headers);
      headers.delete("x-opencode-directory");
      return web(new Request(request, { headers })).then((response) =>
        extensionResponse(path, response),
      );
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
