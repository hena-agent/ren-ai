import { expect, it, vi } from "vitest";
import { deliverPermissionProfile, downloadEnrollmentProfile } from "./fleet.ts";

it("uploads one free unassigned profile using native Bearer auth, without replacing other policies", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const result = await deliverPermissionProfile(
    "https://fleet.example",
    "fleet-secret",
    { identifier: "dev.hena.test", xml: "<plist/>" },
    async (url, init) => {
      calls.push({ url: url.toString(), init });
      return new Response("{}");
    },
  );
  expect(result).toBe("created");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://fleet.example/api/v1/fleet/configuration_profiles");
  const init = calls[0]?.init;
  expect(init?.method).toBe("POST");
  expect(init?.headers).toEqual({ Authorization: "Bearer fleet-secret" });
  expect(init?.redirect).toBe("error");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(init?.body).toBeInstanceOf(FormData);
  if (!(init?.body instanceof FormData)) throw new Error("No form");
  expect([...init.body.keys()]).toEqual(["profile"]);
  const file = init.body.get("profile");
  if (!(file instanceof File)) throw new Error("No file");
  expect(file.name).toBe("messaging.mobileconfig");
  expect(file.type).toBe("application/x-apple-aspen-config");
  expect(await file.text()).toBe("<plist/>");
});

it("downloads the manual Device Enrollment profile using the setup token", async () => {
  const xml = await downloadEnrollmentProfile(
    "https://fleet.example/",
    "fleet-secret",
    async (url, init) => {
      expect(url.toString()).toBe("https://fleet.example/api/v1/fleet/enrollment_profiles/manual");
      expect(init.headers).toEqual({ Authorization: "Bearer fleet-secret" });
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response("<plist>enrollment</plist>");
    },
  );
  expect(xml).toBe("<plist>enrollment</plist>");
});

it("checks all pages and downloads an identical conflicting profile rather than rewriting the list", async () => {
  const calls: string[] = [];
  const replies = [
    new Response("duplicate", { status: 409 }),
    Response.json({
      profiles: [
        { profile_uuid: "windows" },
        { identifier: "another-policy", profile_uuid: "other" },
      ],
      meta: { has_next_results: true },
    }),
    Response.json({
      profiles: [{ identifier: "dev.hena.test", profile_uuid: "uuid/with?characters" }],
      meta: { has_next_results: false },
    }),
    new Response("<plist/>"),
  ];
  const result = await deliverPermissionProfile(
    "https://fleet.example",
    "fleet-secret",
    { identifier: "dev.hena.test", xml: "<plist/>" },
    async (url, init) => {
      calls.push(`${init.method} ${url.toString()}`);
      expect(init.headers).toEqual({ Authorization: "Bearer fleet-secret" });
      expect(init.redirect).toBe("error");
      const response = replies.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    },
  );
  expect(result).toBe("already-present");
  expect(calls).toEqual([
    "POST https://fleet.example/api/v1/fleet/configuration_profiles",
    "GET https://fleet.example/api/v1/fleet/configuration_profiles?page=0&per_page=100",
    "GET https://fleet.example/api/v1/fleet/configuration_profiles?page=1&per_page=100",
    "GET https://fleet.example/api/v1/fleet/configuration_profiles/uuid%2Fwith%3Fcharacters?alt=media",
  ]);
  expect(replies).toHaveLength(0);
});

it.each([
  ["http://fleet.example", "token"],
  ["https://user@fleet.example", "token"],
  ["https://:password@fleet.example", "token"],
  ["https://fleet.example/prefix", "token"],
  ["https://fleet.example/?query=1", "token"],
  ["https://fleet.example/#fragment", "token"],
  ["https://fleet.example", ""],
  ["https://fleet.example", " "],
  ["https://fleet.example", "token\rheader"],
  ["https://fleet.example", "token\nheader"],
])("rejects unsafe credentials/origin before any network access: %s", async (url, token) => {
  const http = vi.fn<() => Promise<Response>>(async () => new Response());
  await expect(
    deliverPermissionProfile(url, token, { identifier: "id", xml: "xml" }, http),
  ).rejects.toThrow(/Fleet (URL|API token)/);
  expect(http).not.toHaveBeenCalled();
});

it.each([401, 403, 500])(
  "reports upload HTTP %i without leaking response bodies or tokens",
  async (status) => {
    await expect(
      deliverPermissionProfile(
        "https://fleet.example",
        "secret",
        { identifier: "id", xml: "xml" },
        async () => new Response("secret", { status }),
      ),
    ).rejects.toThrow(`Fleet profile upload failed (HTTP ${status})`);
  },
);

it.each([
  {
    replies: [Response.json({ profiles: [], meta: { has_next_results: false } })],
    error: "Fleet profile conflict does not match this policy",
  },
  {
    replies: [new Response("secret", { status: 403 })],
    error: "Fleet profile lookup failed (HTTP 403)",
  },
  {
    replies: [
      Response.json({
        profiles: [{ identifier: "id", profile_uuid: "uuid" }],
        meta: { has_next_results: false },
      }),
      new Response("secret", { status: 500 }),
    ],
    error: "Fleet profile lookup failed (HTTP 500)",
  },
  {
    replies: [
      Response.json({
        profiles: [{ identifier: "id", profile_uuid: "uuid" }],
        meta: { has_next_results: false },
      }),
      new Response("different-policy"),
    ],
    error: "Existing Fleet profile content differs; refusing to replace it",
  },
])(
  "fails closed for conflicts and leaves all existing profiles untouched ($error)",
  async ({ replies, error }) => {
    const queue = [new Response("conflict", { status: 409 }), ...replies];
    const calls: string[] = [];
    await expect(
      deliverPermissionProfile(
        "https://fleet.example",
        "secret",
        { identifier: "id", xml: "xml" },
        async (_url, init) => {
          calls.push(String(init.method));
          const response = queue.shift();
          if (!response) throw new Error("Unexpected request");
          return response;
        },
      ),
    ).rejects.toThrow(error);
    expect(calls).toEqual(["POST", ...replies.map(() => "GET")]);
  },
);

it.each([
  null,
  {},
  { profiles: "not a list", meta: { has_next_results: false } },
  { profiles: [{}], meta: { has_next_results: false } },
  { profiles: [{ identifier: 1, profile_uuid: "uuid" }], meta: { has_next_results: false } },
  { profiles: [], meta: { has_next_results: "false" } },
])("rejects malformed Fleet metadata at the API boundary: %j", async (metadata) => {
  let first = true;
  await expect(
    deliverPermissionProfile(
      "https://fleet.example",
      "secret",
      { identifier: "id", xml: "xml" },
      async () => {
        if (first) {
          first = false;
          return new Response("", { status: 409 });
        }
        return Response.json(metadata);
      },
    ),
  ).rejects.toThrow(/Expected|Missing/);
});

it("propagates failed enrollment downloads without printing response secrets", async () => {
  await expect(
    downloadEnrollmentProfile(
      "https://fleet.example",
      "secret",
      async () => new Response("secret", { status: 401 }),
    ),
  ).rejects.toThrow("Fleet enrollment download failed (HTTP 401)");
});

it("bounds authenticated requests to thirty seconds", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  try {
    await downloadEnrollmentProfile(
      "https://fleet.example",
      "secret",
      async () => new Response("xml"),
    );
    expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000);
  } finally {
    timeout.mockRestore();
  }
});
