import { expect, test, vi } from "vitest";
import { expectViewerMutationsDenied, expectViewerRead } from "./viewer-check.test-helper.ts";
import { viewerFront } from "./viewer.ts";

const auth = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;
const location = { directory: "/trusted/default" };
const secret = "provider-secret";

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
