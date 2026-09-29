import { expect, test, vi } from "vitest";
import { expectViewerMutationsDenied, expectViewerRead } from "./viewer-check.test-helper.ts";
import { viewerFront } from "./viewer.ts";

const auth = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;
const defaultLocation = () =>
  Response.json({
    directory: "/repo",
    project: { id: "project", directory: "/repo", canonical: "/repo" },
  });

test("Extensions reads return display metadata only, never configuration, paths or skill content", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/location") return defaultLocation();
    const data =
      path === "/api/mcp"
        ? [
            { name: "calendar", status: { status: "failed", error: "provider-secret" } },
            { name: "auth", status: { status: "needs_auth", error: "provider-secret" } },
            { name: "ready", status: { status: "connected" } },
          ]
        : path === "/api/plugin"
          ? [
              {
                id: "calendar-plugin",
                source: { type: "local", path: "/private/provider-secret" },
                features: { server: true },
                state: { status: "failed", error: "provider-secret" },
              },
            ]
          : [
              {
                id: "skill-id",
                name: "calendar-skill",
                description: "provider-secret",
                path: "/private/provider-secret",
                content: "provider-secret",
              },
            ];
    return Response.json({ location: { directory: "/repo" }, data });
  });
  const viewer = viewerFront(web, "secret");
  for (const [path, expected] of [
    [
      "/api/mcp",
      [
        { name: "calendar", status: { status: "failed", error: "Details hidden" } },
        { name: "auth", status: { status: "needs_auth", error: "Details hidden" } },
        { name: "ready", status: { status: "connected" } },
      ],
    ],
    [
      "/api/plugin",
      [
        {
          id: "calendar-plugin",
          source: { type: "local", path: "/" },
          features: {},
          state: { status: "failed", error: "Details hidden" },
        },
      ],
    ],
    [
      "/api/skill?location%5Bdirectory%5D=",
      [{ id: "skill-id", name: "calendar-skill", path: "/", content: "" }],
    ],
  ] as const) {
    await expectViewerRead(
      viewer,
      path,
      auth,
      { location: { directory: "/repo" }, data: expected },
      "provider-secret",
    );
  }
  expect(web).toHaveBeenCalledTimes(3);
  for (const path of [
    "/api/config",
    "/api/provider/sample",
    "/api/mcp/resource",
    "/api/skill?location%5Bdirectory%5D=%2Fprivate",
    "/api/plugin?location%5Bdirectory%5D=%2Fprivate",
    "/api/mcp?location%5Bdirectory%5D=%2Fprivate",
  ]) {
    expect(
      (await viewer(new Request(`http://localhost${path}`, { headers: { authorization: auth } })))
        .status,
    ).toBe(403);
  }
  await expectViewerMutationsDenied(viewer, ["/api/mcp", "/api/plugin", "/api/skill"], auth);
  expect(web).toHaveBeenCalledTimes(6);
});

test("Extensions fails closed on unsafe metadata, arbitrary locations, and host errors", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/location") return defaultLocation();
    if (path === "/api/mcp") return new Response("provider-secret", { status: 500 });
    if (path === "/api/skill") return Response.json({ data: [{ content: "provider-secret" }] });
    return Response.json({
      location: { directory: "/repo" },
      data: [
        { source: { type: "builtin" }, features: { rpc: true }, state: { status: "active" } },
        {
          id: "token=provider-secret",
          source: { type: "package", target: "https://user:provider-secret@example.com/plugin" },
          features: {},
          state: { status: "active" },
        },
        {
          id: "/private/provider-secret",
          source: { type: "package", target: "/private/provider-secret" },
          features: {},
          state: { status: "active" },
        },
        {
          source: { type: "package", target: "@!unsafe/package" },
          features: {},
          state: { status: "active" },
        },
        {
          source: { type: "package", target: "!unsafe" },
          features: {},
          state: { status: "active" },
        },
        {
          source: { type: "package", target: "@vendor/safe-package" },
          features: {},
          state: { status: "active" },
        },
      ],
    });
  });
  const viewer = viewerFront(web, "secret");
  expect(
    (await viewer(new Request("http://localhost/api/mcp", { headers: { authorization: auth } })))
      .status,
  ).toBe(500);
  expect(
    (await viewer(new Request("http://localhost/api/skill", { headers: { authorization: auth } })))
      .status,
  ).toBe(502);
  const plugins = await viewer(
    new Request("http://localhost/api/plugin", {
      headers: { authorization: auth, "x-opencode-directory": "/private" },
    }),
  );
  expect(web.mock.lastCall![0].headers.get("x-opencode-directory")).toBeNull();
  expect(await plugins.json()).toEqual({
    location: { directory: "/repo" },
    data: [
      { source: { type: "builtin" }, features: {}, state: { status: "active" } },
      { source: { type: "package", target: "package" }, features: {}, state: { status: "active" } },
      { source: { type: "package", target: "package" }, features: {}, state: { status: "active" } },
      { source: { type: "package", target: "package" }, features: {}, state: { status: "active" } },
      { source: { type: "package", target: "package" }, features: {}, state: { status: "active" } },
      {
        source: { type: "package", target: "@vendor/safe-package" },
        features: {},
        state: { status: "active" },
      },
    ],
  });
  for (const path of [
    "/api/mcp?location%5Bdirectory%5D=&location%5Bdirectory%5D=%2Fprivate",
    "/api/mcp?location%5Bdirectory%5D=%2Frepo&location%5Bdirectory%5D=%2Fprivate",
    "/api/plugin?location%5Bdirectory%5D=%2Fprivate",
    "/api/plugin?unexpected=",
    "/api/skill?location%5BworkspaceID%5D=other",
  ]) {
    expect(
      (await viewer(new Request(`http://localhost${path}`, { headers: { authorization: auth } })))
        .status,
    ).toBe(403);
  }
  expect(web).toHaveBeenCalledTimes(6);
});

test("the UI's explicit default directory reads Extensions without opening arbitrary locations", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/location") {
      return Response.json({
        directory: "/trusted/default",
        project: { id: "project", directory: "/trusted/default", canonical: "/trusted/default" },
      });
    }
    expect(request.headers.get("x-opencode-directory")).toBeNull();
    expect(url.search).toBe("");
    if (url.pathname === "/api/skill") {
      return Response.json({
        location: { directory: "/trusted/default" },
        data: [{ id: "sample", name: "sample", path: "/secret", content: "secret" }],
      });
    }
    return Response.json({ location: { directory: "/trusted/default" }, data: [] });
  });
  const viewer = viewerFront(web, "secret");
  const request = (directory: string) =>
    viewer(
      new Request(
        `http://localhost/api/skill?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
        { headers: { authorization: auth, "x-opencode-directory": "/untrusted" } },
      ),
    );
  expect((await request("/different")).status).toBe(403);
  const response = await request("/trusted/default");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    location: { directory: "/trusted/default" },
    data: [{ id: "sample", name: "sample", path: "/", content: "" }],
  });
  expect(web.mock.calls.map(([received]) => new URL(received.url).pathname)).toEqual([
    "/api/location",
    "/api/location",
    "/api/skill",
  ]);
});
