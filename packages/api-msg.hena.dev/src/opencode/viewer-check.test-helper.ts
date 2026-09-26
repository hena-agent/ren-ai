import { Effect } from "effect";
import { viewerFront } from "./viewer.ts";

export const expectedViewerResults = (sessionID: string, messageID: string) => ({
  publicRoutes: [
    "/api/info",
    "/api/project",
    "/api/location",
    "/api/session",
    `/api/session/${sessionID}`,
    `/api/session/${sessionID}/message`,
    `/api/session/${sessionID}/inbox`,
    `/api/session/${sessionID}/message/${messageID}`,
  ].map((path) => `${path}:200:401`),
  forbiddenRoutes: [
    "/api/config:403",
    "/api/plugin:403",
    "/openapi.json:403",
    "/api/session/active:403",
  ],
  post: "/api/session:403",
  events: 200,
});

export const verifyViewer = (
  web: (request: Request) => Promise<Response>,
  directory: string,
  sessionID: string,
  messageID: string,
) =>
  Effect.gen(function* () {
    const viewer = viewerFront(web, "only-the-operator-knows");
    const authorization = `Basic ${Buffer.from("opencode:only-the-operator-knows").toString("base64")}`;
    const viewed = (path: string, method = "GET", authenticated = true) =>
      viewer(
        new Request(`http://host.local${path}`, {
          method,
          headers: {
            ...(authenticated ? { authorization } : {}),
            "x-opencode-directory": directory,
          },
        }),
      );
    const publicRoutes: string[] = [];
    for (const path of [
      "/api/info",
      "/api/project",
      "/api/location",
      "/api/session",
      `/api/session/${sessionID}`,
      `/api/session/${sessionID}/message`,
      `/api/session/${sessionID}/inbox`,
      `/api/session/${sessionID}/message/${messageID}`,
    ]) {
      const allowed = yield* Effect.promise(() => viewed(path));
      const refused = yield* Effect.promise(() => viewed(path, "GET", false));
      publicRoutes.push(`${path}:${allowed.status}:${refused.status}`);
    }
    const forbiddenRoutes: string[] = [];
    for (const path of ["/api/config", "/api/plugin", "/openapi.json", "/api/session/active"]) {
      forbiddenRoutes.push(`${path}:${(yield* Effect.promise(() => viewed(path))).status}`);
    }
    const postPath = "/api/session";
    const post = yield* Effect.promise(() => viewed(postPath, "POST"));
    const events = yield* Effect.promise(() => viewed("/api/event"));
    yield* Effect.promise(() => events.body!.cancel());
    return {
      publicRoutes,
      forbiddenRoutes,
      post: `${postPath}:${post.status}`,
      events: events.status,
    };
  });
