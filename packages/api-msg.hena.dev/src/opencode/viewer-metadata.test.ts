import { FileSystem } from "@opencode/schema/filesystem";
import { Location } from "@opencode/schema/location";
import { Schema } from "effect";
import { expect, test, vi } from "vitest";
import { expectViewerMutationsDenied, expectViewerRead } from "./viewer-check.test-helper.ts";
import { viewerFront } from "./viewer.ts";

const auth = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;
const location = { directory: "/trusted/default" };
const secret = "provider-secret";
const defaultLocation = () =>
  Response.json({
    ...location,
    project: { id: "project", directory: location.directory, canonical: location.directory },
  });

test("the V2 file tree gets an empty schema-valid listing without reading host files", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>(async (request) => {
    expect(new URL(request.url).pathname).toBe("/api/location");
    expect(new URL(request.url).search).toBe("");
    expect([...request.headers]).toEqual([]);
    return defaultLocation();
  });
  const viewer = viewerFront(web, "secret");
  for (const query of [
    "",
    "?path=",
    "?path=.",
    "?path=src&location[directory]=/trusted/default",
    "?path=../../private&path=/private&location[directory]=",
  ]) {
    await expectViewerRead(viewer, `/api/fs/list${query}`, auth, { location, data: [] }, "private");
  }
  const response = await viewer(
    new Request("http://localhost/api/fs/list?path=&location[directory]=/trusted/default", {
      headers: { authorization: auth, "x-opencode-directory": "/private" },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(
    Schema.decodeUnknownSync(Location.response(Schema.Array(FileSystem.Entry)))(
      await response.json(),
    ),
  ).toEqual({ location, data: [] });
  expect(web).toHaveBeenCalled();
});

test("file compatibility keeps authentication, location restrictions and filesystem writes closed", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>(async () => defaultLocation());
  const viewer = viewerFront(web, "secret");
  for (const path of [
    "/api/fs/list?path=&location[directory]=/private",
    "/api/fs/list?location[directory]=/trusted/default&location[directory]=/private",
    "/api/fs/list?location[workspaceID]=other",
    "/api/fs/list?unexpected=",
    "/api/fs/list/extra",
    "/api/fs/read/private",
    "/api/fs/find?query=secret",
    "/api/config",
  ]) {
    expect(
      (await viewer(new Request(`http://localhost${path}`, { headers: { authorization: auth } })))
        .status,
    ).toBe(403);
  }
  expect(web).toHaveBeenCalledTimes(2);
  web.mockClear();
  expect(
    (
      await viewer(
        new Request("http://localhost/api/fs/list?path=", {
          headers: { authorization: "Basic wrong" },
        }),
      )
    ).status,
  ).toBe(401);
  await expectViewerMutationsDenied(viewer, ["/api/fs/list", "/api/experimental/fs/write"], auth);
  expect(web).not.toHaveBeenCalled();
});

test("the configured Persona directory works even when the host default is elsewhere", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>(async () => defaultLocation());
  const viewer = viewerFront(web, "secret", undefined, "/trusted/personas");
  for (const query of ["", "?path=&location[directory]=/trusted/personas"]) {
    await expectViewerRead(
      viewer,
      `/api/fs/list${query}`,
      auth,
      { location: { directory: "/trusted/personas" }, data: [] },
      "private",
    );
  }
  for (const query of [
    "?location[directory]=/trusted/default",
    "?location[directory]=/private",
    "?location[directory]=/trusted/personas&location[directory]=/private",
  ]) {
    expect(
      (
        await viewer(
          new Request(`http://localhost/api/fs/list${query}`, { headers: { authorization: auth } }),
        )
      ).status,
    ).toBe(403);
  }
  expect(web).not.toHaveBeenCalled();
});

test("file listing fails closed when the host cannot supply its default location", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>();
  const viewer = viewerFront(web, "secret");
  for (const respond of [
    async () => new Response("private", { status: 503 }),
    async () => Response.json({ secret: "private" }),
    async () => Promise.reject(new Error("private")),
  ]) {
    web.mockImplementation(respond);
    const response = await viewer(
      new Request("http://localhost/api/fs/list?path=", { headers: { authorization: auth } }),
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("");
  }
});

test("metadata reads preserve V2 display fields but remove credentials and arbitrary provider options", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>(async (request) => {
    const url = new URL(request.url);
    expect(url.search).toBe("");
    expect(request.headers.get("x-opencode-directory")).toBeNull();
    const data =
      url.pathname === "/api/provider"
        ? [
            {
              id: "sample",
              name: "Sample",
              activation: "enabled",
              package: secret,
              settings: { apiKey: secret, baseURL: `https://${secret}.example` },
              headers: { authorization: secret },
              body: { secret },
            },
          ]
        : url.pathname === "/api/model"
          ? [
              {
                id: "sample-model",
                modelID: "sample-model",
                providerID: "sample",
                name: "Sample model",
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                variants: [
                  { id: "fast", settings: { apiKey: secret }, headers: { authorization: secret } },
                ],
                time: { released: 1 },
                cost: [],
                status: "active",
                enabled: true,
                limit: { context: 100, output: 10 },
                settings: { apiKey: secret },
                body: { secret },
                headers: { authorization: secret },
                package: secret,
              },
            ]
          : url.pathname === "/api/integration"
            ? [
                {
                  id: "sample-integration",
                  name: "Integration",
                  metadata: { secret },
                  methods: [{ type: "env", names: [secret] }],
                  connections: [{ type: "env", name: secret }],
                },
              ]
            : { provider: "git", branch: { current: "main", default: "main" }, secret };
    return Response.json({ location, data });
  });
  const viewer = viewerFront(web, "secret");
  for (const [path, expected] of [
    ["/api/provider", [{ id: "sample", name: "Sample", activation: "enabled", package: "" }]],
    [
      "/api/model",
      [
        {
          id: "sample-model",
          modelID: "sample-model",
          providerID: "sample",
          name: "Sample model",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [{ id: "fast" }],
          time: { released: 1 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 100, output: 10 },
        },
      ],
    ],
    [
      "/api/integration",
      [{ id: "sample-integration", name: "Integration", methods: [], connections: [] }],
    ],
    ["/api/vcs", { provider: "git", branch: { current: "main", default: "main" } }],
  ] as const) {
    await expectViewerRead(viewer, path, auth, { location, data: expected }, secret);
  }
  expect(web).toHaveBeenCalledTimes(4);
});

test("active sessions expose IDs and running status only; metadata rejects unsafe paths and host errors", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/session/active")
      return Response.json({ data: { ses_example: { type: "running", secret } } });
    if (path === "/api/model") return new Response(secret, { status: 500 });
    if (path === "/api/integration") return Response.json({ data: [{ metadata: { secret } }] });
    if (path === "/api/location")
      return Response.json({
        directory: "/trusted/default",
        project: { id: "project", directory: "/trusted/default", canonical: "/trusted/default" },
      });
    return Response.json({ location, data: [] });
  });
  const viewer = viewerFront(web, "secret");
  const active = await viewer(
    new Request("http://localhost/api/session/active", { headers: { authorization: auth } }),
  );
  expect(await active.json()).toEqual({ data: { ses_example: { type: "running" } } });
  expect(
    (await viewer(new Request("http://localhost/api/model", { headers: { authorization: auth } })))
      .status,
  ).toBe(500);
  expect(
    (
      await viewer(
        new Request("http://localhost/api/integration", { headers: { authorization: auth } }),
      )
    ).status,
  ).toBe(502);
  for (const path of [
    "/api/model/default",
    "/api/integration/sample-integration",
    "/api/vcs/status",
    "/api/config",
    "/api/provider?location%5Bdirectory%5D=%2Fprivate",
    "/api/session/active?anything=",
    "/api/session/active?location%5Bdirectory%5D=",
  ]) {
    expect(
      (await viewer(new Request(`http://localhost${path}`, { headers: { authorization: auth } })))
        .status,
    ).toBe(403);
  }
  await expectViewerMutationsDenied(
    viewer,
    ["/api/provider", "/api/model", "/api/integration", "/api/vcs", "/api/session/active"],
    auth,
  );
  expect(web).toHaveBeenCalledTimes(4);
});

test("a failed default-location lookup cannot authorize a requested directory", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>(
    async () => new Response("private", { status: 503 }),
  );
  const viewer = viewerFront(web, "secret");
  const response = await viewer(
    new Request("http://localhost/api/skill?location%5Bdirectory%5D=%2Ftrusted", {
      headers: { authorization: auth },
    }),
  );
  expect(response.status).toBe(403);
  expect(web).toHaveBeenCalledTimes(1);
  expect(new URL(web.mock.lastCall![0].url).pathname).toBe("/api/location");
});

test("an invalid default-location response fails closed without exposing host details", async () => {
  const web = vi.fn<(request: Request) => Promise<Response>>(async () => Response.json({ secret }));
  const viewer = viewerFront(web, "secret");
  const response = await viewer(
    new Request("http://localhost/api/skill?location%5Bdirectory%5D=%2Ftrusted", {
      headers: { authorization: auth },
    }),
  );
  expect(response.status).toBe(502);
  expect(await response.text()).toBe("");
  expect(web).toHaveBeenCalledTimes(1);
});
