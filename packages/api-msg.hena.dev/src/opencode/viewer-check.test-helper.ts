import { Effect } from "effect";
import { expect } from "vitest";
import { viewerFront } from "./viewer.ts";

export const expectViewerRead = async (
  viewer: ReturnType<typeof viewerFront>,
  path: string,
  authorization: string,
  expected: object,
  redacted: string,
) => {
  expect((await viewer(new Request(`http://localhost${path}`))).status).toBe(401);
  const response = await viewer(
    new Request(`http://localhost${path}`, { headers: { authorization } }),
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain(redacted);
  expect(JSON.parse(body)).toEqual(expected);
};

export const expectViewerMutationsDenied = async (
  viewer: ReturnType<typeof viewerFront>,
  paths: readonly string[],
  authorization: string,
) => {
  for (const path of paths) {
    const response = await viewer(
      new Request(`http://localhost${path}`, { method: "POST", headers: { authorization } }),
    );
    expect(response.status).toBe(403);
  }
};

export const expectedViewerResults = (sessionID: string, messageID: string) => ({
  publicRoutes: [
    "/api/info",
    "/api/project",
    "/api/location",
    "/api/mcp",
    "/api/plugin",
    "/api/skill",
    "/api/provider",
    "/api/model",
    "/api/integration",
    "/api/vcs",
    "/api/session/active",
    "/api/session",
    `/api/session/${sessionID}`,
    `/api/session/${sessionID}/message`,
    `/api/session/${sessionID}/inbox`,
    `/api/session/${sessionID}/message/${messageID}`,
  ].map((path) => `${path}:200:401`),
  forbiddenRoutes: [
    "/api/config:403",
    "/api/provider/private:403",
    "/openapi.json:403",
    "/api/vcs/status:403",
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
    const publicBodies: Record<string, string> = {};
    for (const path of [
      "/api/info",
      "/api/project",
      "/api/location",
      "/api/mcp",
      "/api/plugin",
      "/api/skill",
      "/api/provider",
      "/api/model",
      "/api/integration",
      "/api/vcs",
      "/api/session/active",
      "/api/session",
      `/api/session/${sessionID}`,
      `/api/session/${sessionID}/message`,
      `/api/session/${sessionID}/inbox`,
      `/api/session/${sessionID}/message/${messageID}`,
    ]) {
      const allowed = yield* Effect.promise(() => viewed(path));
      publicBodies[path] = yield* Effect.promise(() => allowed.text());
      const refused = yield* Effect.promise(() => viewed(path, "GET", false));
      publicRoutes.push(`${path}:${allowed.status}:${refused.status}`);
    }
    const forbiddenRoutes: string[] = [];
    for (const path of [
      "/api/config",
      "/api/provider/private",
      "/openapi.json",
      "/api/vcs/status",
    ]) {
      forbiddenRoutes.push(`${path}:${(yield* Effect.promise(() => viewed(path))).status}`);
    }
    const postPath = "/api/session";
    const post = yield* Effect.promise(() => viewed(postPath, "POST"));
    const events = yield* Effect.promise(() => viewed("/api/event"));
    yield* Effect.promise(() => events.body!.cancel());
    return {
      publicRoutes,
      publicBodies,
      forbiddenRoutes,
      post: `${postPath}:${post.status}`,
      events: events.status,
    };
  });
