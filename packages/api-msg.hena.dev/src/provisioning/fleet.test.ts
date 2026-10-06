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

it("downloads signed company-owned OTA Device Enrollment bytes using an existing global secret", async () => {
  const bytes = new Uint8Array([48, 130, 255, 0, 128]);
  const calls: string[] = [];
  const profile = await downloadEnrollmentProfile(
    "https://fleet.example/",
    "fleet-secret",
    async (url, init) => {
      calls.push(url.toString());
      expect(init.headers).toEqual({ Authorization: "Bearer fleet-secret" });
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return calls.length === 1
        ? Response.json({ spec: { secrets: [{ secret: "enroll&?+/=✓" }, { secret: "other" }] } })
        : new Response(bytes);
    },
  );
  expect(calls).toEqual([
    "https://fleet.example/api/v1/fleet/spec/enroll_secret",
    "https://fleet.example/api/v1/fleet/enrollment_profiles/ota?enroll_secret=enroll%26%3F%2B%2F%3D%E2%9C%93",
  ]);
  expect(new Uint8Array(profile)).toEqual(bytes);
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
  await expect(downloadEnrollmentProfile(url, token, http)).rejects.toThrow(
    /Fleet (URL|API token)/,
  );
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

it.each([
  null,
  {},
  { spec: {} },
  { spec: { secrets: "not a list" } },
  { spec: { secrets: [] } },
  { spec: { secrets: [{}] } },
  { spec: { secrets: [{ secret: 123456 }] } },
  { spec: { secrets: [{ secret: "" }] } },
  { spec: { secrets: [{ secret: " " }] } },
])(
  "rejects invalid global enroll secrets without exposing metadata or downloading a profile: %j",
  async (metadata) => {
    const http = vi.fn<() => Promise<Response>>(async () => Response.json(metadata));
    await expect(
      downloadEnrollmentProfile("https://fleet.example", "token", http),
    ).rejects.toMatchObject({
      message: "Invalid Fleet enroll secrets response",
    });
    expect(http).toHaveBeenCalledTimes(1);
  },
);

it.each(["secrets", "ota"])(
  "redacts secret-bearing transport errors during %s requests",
  async (stage) => {
    await expect(
      downloadEnrollmentProfile("https://fleet.example", "api-secret", async (url) => {
        if (stage === "secrets" || url.pathname.endsWith("/ota"))
          throw new Error(`Request failed ${url.toString()} api-secret`);
        return Response.json({ spec: { secrets: [{ secret: "enroll-secret" }] } });
      }),
    ).rejects.toMatchObject({ message: "Fleet enrollment request failed" });
  },
);

it("redacts secret-bearing errors when reading the signed profile body", async () => {
  await expect(
    downloadEnrollmentProfile("https://fleet.example", "token", async (url) => {
      if (url.pathname.endsWith("/enroll_secret"))
        return Response.json({ spec: { secrets: [{ secret: "enroll-secret" }] } });
      return new Response(
        new ReadableStream({ start: (controller) => controller.error("enroll-secret") }),
      );
    }),
  ).rejects.toMatchObject({ message: "Fleet enrollment body download failed" });
});

it.each([401, 402, 403, 500])(
  "fails closed on OTA HTTP %i without a Premium fallback",
  async (status) => {
    const requests: string[] = [];
    await expect(
      downloadEnrollmentProfile("https://fleet.example", "token", async (url) => {
        requests.push(url.pathname);
        return requests.length === 1
          ? Response.json({ spec: { secrets: [{ secret: "secret" }] } })
          : new Response("secret response", { status });
      }),
    ).rejects.toThrow(`Fleet enrollment download failed (HTTP ${status})`);
    expect(requests).toEqual([
      "/api/v1/fleet/spec/enroll_secret",
      "/api/v1/fleet/enrollment_profiles/ota",
    ]);
  },
);

it("redacts malformed JSON instead of exposing enrollment response content", async () => {
  await expect(
    downloadEnrollmentProfile(
      "https://fleet.example",
      "token",
      async () => new Response("secret malformed JSON"),
    ),
  ).rejects.toMatchObject({ message: "Invalid Fleet enroll secrets response" });
});

it("bounds authenticated requests to thirty seconds", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  try {
    await downloadEnrollmentProfile("https://fleet.example", "secret", async (url) =>
      url.pathname.endsWith("/enroll_secret")
        ? Response.json({ spec: { secrets: [{ secret: "secret" }] } })
        : new Response("signed profile"),
    );
    expect(timeout.mock.calls).toEqual([[30_000], [30_000]]);
  } finally {
    timeout.mockRestore();
  }
});
