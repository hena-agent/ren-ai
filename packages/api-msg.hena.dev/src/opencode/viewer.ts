import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Location } from "@opencode/schema/location";
import { Mcp } from "@opencode/schema/mcp";
import { Model } from "@opencode/schema/model";
import { Plugin } from "@opencode/schema/plugin";
import { Provider } from "@opencode/schema/provider";
import { Skill } from "@opencode/schema/skill";
import { Integration } from "@opencode/schema/integration";
import { Vcs } from "@opencode/schema/vcs";
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
const metadata = new Set(["/api/provider", "/api/model", "/api/integration", "/api/vcs"]);
const pluginName = /^(?:@[a-z\d][\w.-]*\/)?[a-z\d][\w.-]*$/i;

const defaultLocation = async (
  web: (request: Request) => Promise<Response>,
  url: URL,
): Promise<string | undefined> => {
  const response = await web(new Request(new URL("/api/location", url)));
  if (!response.ok) return undefined;
  return Schema.decodeUnknownSync(Location.PublicInfo)(await response.json()).directory;
};

const safeLocation = async (
  web: (request: Request) => Promise<Response>,
  url: URL,
  directory?: string,
): Promise<boolean> => {
  const params = [...url.searchParams];
  if (params.some(([key]) => key !== "location[directory]")) return false;
  const values = params.map(([, value]) => value).filter(Boolean);
  if (values.length === 0) return true;
  const permitted = directory ?? (await defaultLocation(web, url));
  return values.every((value) => value === permitted);
};

const emptyFileList = async (
  web: (request: Request) => Promise<Response>,
  url: URL,
  fileDirectory?: string,
): Promise<Response> => {
  // The stock UI loads a file tree, but this viewer exposes conversations only.
  url.searchParams.delete("path");
  if (!(await safeLocation(web, url, fileDirectory))) return new Response(null, { status: 403 });
  const directory = fileDirectory ?? (await defaultLocation(web, url));
  if (!directory) return new Response(null, { status: 502 });
  return Response.json({ location: { directory }, data: [] });
};

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

const metadataResponse = async (path: string, response: Response): Promise<Response> => {
  if (!response.ok) return new Response(null, { status: response.status });
  try {
    const body = await response.json();
    if (path === "/api/session/active") {
      const data = Schema.decodeUnknownSync(
        Schema.Struct({
          data: Schema.Record(Schema.String, Schema.Struct({ type: Schema.Literal("running") })),
        }),
      )(body);
      return Response.json(data);
    }
    if (path === "/api/provider") {
      const { location, data } = Schema.decodeUnknownSync(
        Location.response(Schema.Array(Provider.Info)),
      )(body);
      return Response.json({
        location,
        data: data.map(({ id, name, activation }) => ({ id, name, activation, package: "" })),
      });
    }
    if (path === "/api/model") {
      const { location, data } = Schema.decodeUnknownSync(
        Location.response(Schema.Array(Model.Info)),
      )(body);
      return Response.json({
        location,
        data: data.map(
          ({
            id,
            modelID,
            providerID,
            name,
            capabilities,
            variants,
            time,
            cost,
            status,
            enabled,
            limit,
          }) => ({
            id,
            modelID,
            providerID,
            name,
            capabilities,
            variants: variants.map(({ id: variantID }) => ({ id: variantID })),
            time,
            cost,
            status,
            enabled,
            limit,
          }),
        ),
      });
    }
    if (path === "/api/integration") {
      const { location, data } = Schema.decodeUnknownSync(
        Location.response(Schema.Array(Integration.Info)),
      )(body);
      return Response.json({
        location,
        data: data.map(({ id, name }) => ({ id, name, methods: [], connections: [] })),
      });
    }
    const { location, data } = Schema.decodeUnknownSync(Location.response(Vcs.Info))(body);
    return Response.json({ location, data });
  } catch {
    return new Response(null, { status: 502 });
  }
};

/** The raw host handler must never be exposed directly: GET /api/config contains provider keys. */
export const viewerFront = (
  web: (request: Request) => Promise<Response>,
  password: string,
  ui?: (request: Request) => Promise<Response>,
  fileDirectory?: string,
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
    if (path === "/api/fs/list") {
      return emptyFileList(web, url, fileDirectory).catch(
        () => new Response(null, { status: 502 }),
      );
    }
    if (extensions.has(path) || metadata.has(path) || path === "/api/session/active") {
      if (path === "/api/session/active" && url.search) {
        return Promise.resolve(new Response(null, { status: 403 }));
      }
      return safeLocation(web, url)
        .then((safe) =>
          safe
            ? web(new Request(new URL(path, url))).then((response) =>
                extensions.has(path)
                  ? extensionResponse(path, response)
                  : metadataResponse(path, response),
              )
            : new Response(null, { status: 403 }),
        )
        .catch(() => new Response(null, { status: 502 }));
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
  fileDirectory?: string,
) =>
  Effect.gen(function* () {
    const password = yield* Config.string("VIEWER_PASSWORD");
    // The isolated CLI serves only immutable V2 app assets here. Its API is never proxied.
    const front = viewerFront(
      web,
      password,
      (request) =>
        fetchAssets(`http://127.0.0.1:47987${new URL(request.url).pathname}`, {
          headers: { "Accept-Encoding": "identity" },
          signal: request.signal,
        }).catch(() => new Response("Web UI unavailable", { status: 502 })),
      fileDirectory,
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
