import { afterEach, expect, test, vi } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type { Metrics } from "@ren-ai/onboarding";
import { createAdmin } from "./admin.ts";
import { managementClient, type ManagementClient } from "./contact-client.ts";
import { fixture, request } from "../test/fixtures.ts";
import type { LogEntry } from "./logging.ts";
afterEach(() => vi.restoreAllMocks());

const data: Metrics = {
  from: "2026-10-27",
  to: "2026-10-27",
  previousFrom: "2026-10-26",
  previousTo: "2026-10-26",
  totals: [
    { day: "2026-10-27", step: "visit", dimension: "total", value: "", count: 10 },
    { day: "2026-10-27", step: "join", dimension: "total", value: "", count: 2 },
  ],
  previous: [],
  personas: [],
  previousPersonas: [],
  endings: [],
  previousEndings: [],
  cost: [],
  previousCost: [],
  alerts: [
    {
      name: "joins-failing",
      raisedAt: 100,
      detail: "등록 저장 실패",
      url: "https://admin.renai.im/waitlist",
    },
  ],
  delivery: { alerts: "accepting", reports: "rejected", pending: 1 },
};

test("지표 is authenticated and renders a selected period, comparison, SVG chart and delivery health", async () => {
  const f = await fixture();
  const metrics = vi.fn<NonNullable<ManagementClient["metrics"]>>(async () => data);
  const admin = createAdmin(f.store, "test-password", {
    management: fromPartial<ManagementClient>({ metrics }),
  });
  expect((await admin(new Request("http://localhost:3729/metrics"))).status).toBe(401);
  const response = await admin(request("/metrics?from=2026-10-27&to=2026-10-27"));
  expect(response.status).toBe(200);
  expect(metrics).toHaveBeenCalledWith({ from: "2026-10-27", to: "2026-10-27" });
  const page = await response.text();
  for (const text of [
    "지표",
    "20.0%",
    "2026-10-26",
    "<svg",
    "등록 저장 실패",
    "거부됨",
    "https://renai.im/explore?metrics=off",
  ])
    expect(page).toContain(text);
});

test("a Metrics read failure logs once, carries its request ID and never exposes credentials", async () => {
  const f = await fixture();
  const logs: LogEntry[] = [];
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
  const admin = createAdmin(f.store, "test-password", {
    management: managementClient("https://api.test", "private-token", fetcher),
    log: (entry) => logs.push(entry),
  });
  const response = await admin(request("/metrics"));
  expect(response.status).toBe(503);
  expect(await response.text()).toContain(response.headers.get("x-request-id"));
  expect(logs.filter((entry) => entry.event === "operation.failed")).toHaveLength(1);
  expect(JSON.stringify(logs)).not.toContain("private-token");
});

test("the selected breakdown, persona outcomes, cohort Retention and cost include the previous period", async () => {
  const f = await fixture();
  const current: Metrics = {
    ...data,
    from: "2026-10-26",
    previousFrom: "2026-10-24",
    previousTo: "2026-10-25",
    totals: [
      ...data.totals,
      { day: "2026-10-26", step: "greeting_sent", dimension: "total", value: "", count: 4 },
      { day: "2026-10-26", step: "retention_1", dimension: "total", value: "", count: 2 },
      { day: "2026-10-27", step: "active", dimension: "total", value: "", count: 3 },
      { day: "2026-10-27", step: "like", dimension: "country", value: "KR", count: 6 },
      { day: "2026-10-26", step: "visit", dimension: "country", value: "JP", count: 3 },
    ],
    previous: [
      { day: "2026-10-25", step: "like", dimension: "country", value: "KR", count: 5 },
      { day: "2026-10-25", step: "visit", dimension: "total", value: "", count: 20 },
      { day: "2026-10-24", step: "greeting_sent", dimension: "total", value: "", count: 2 },
      { day: "2026-10-24", step: "retention_1", dimension: "total", value: "", count: 1 },
      { day: "2026-10-25", step: "active", dimension: "total", value: "", count: 2 },
    ],
    personas: (
      [
        "like",
        "pass",
        "selection",
        "greeting_sent",
        "first_reply",
        "retention_1",
        "ending",
      ] as const
    ).map((step) => ({ ...data.totals[0]!, step, dimension: "persona", value: "sora", count: 2 })),
    previousPersonas: [
      { day: "2026-10-24", step: "like", dimension: "persona", value: "luna", count: 1 },
    ],
    cost: [
      { day: "2026-10-27", cost: 1.2, conversations: 2 },
      { day: "2026-10-26", cost: 0, conversations: 0 },
    ],
    previousCost: [{ day: "2026-10-25", cost: 0.4, conversations: 1 }],
    delivery: { alerts: "unconfigured", reports: "accepting", pending: 0 },
  };
  const admin = createAdmin(f.store, "test-password", {
    management: fromPartial<ManagementClient>({ metrics: async () => current }),
  });
  const response = await admin(request("/metrics?from=2026-10-26&to=2026-10-27&breakdown=country"));
  expect(response.status).toBe(200);
  const page = await response.text();
  for (const text of [
    "KR",
    "JP",
    "sora",
    "luna",
    "50.0%",
    "1.2000",
    "0.4000",
    "0.6000",
    "미설정",
    "첫 인사 날짜별 유지율",
    "현재 / 이전",
  ])
    expect(page).toContain(text);
});

test("presets and empty periods are readable, and unavailable or invalid Metrics requests fail clearly", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-27T03:00:00Z"));
  const f = await fixture();
  const metrics = vi.fn<NonNullable<ManagementClient["metrics"]>>(async () => ({
    ...data,
    totals: [],
    alerts: [],
  }));
  const admin = createAdmin(f.store, "test-password", {
    management: fromPartial<ManagementClient>({ metrics }),
  });
  for (const [period, from, to] of [
    ["today", "2026-10-27", "2026-10-27"],
    ["yesterday", "2026-10-26", "2026-10-26"],
    ["7", "2026-10-21", "2026-10-27"],
    ["30", "2026-09-28", "2026-10-27"],
  ]) {
    const response = await admin(request(`/metrics?period=${period}&breakdown=total`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("등록률: —");
    expect(metrics).toHaveBeenLastCalledWith({ from, to, breakdown: "total" });
  }
  expect((await admin(request("/metrics?from=invalid"))).status).toBe(503);
  const unavailable = await createAdmin(f.store, "test-password")(request("/metrics"));
  expect(unavailable.status).toBe(503);
  expect(await unavailable.text()).toContain(unavailable.headers.get("X-Request-ID"));
});

test("previous-only breakdowns, cohorts and daily costs remain visible when current activity is zero", async () => {
  const f = await fixture();
  const metrics: Metrics = {
    ...data,
    totals: [],
    previous: [
      { day: "2026-10-26", step: "visit", dimension: "country", value: "US", count: 9 },
      { day: "2026-10-26", step: "greeting_sent", dimension: "total", value: "", count: 2 },
    ],
    previousCost: [{ day: "2026-10-26", cost: 4, conversations: 2 }],
  };
  const admin = createAdmin(f.store, "test-password", {
    management: fromPartial<ManagementClient>({ metrics: async () => metrics }),
  });
  const response = await admin(request("/metrics?from=2026-10-27&to=2026-10-27&breakdown=country"));
  const page = await response.text();
  expect(page).toContain("<td>US</td><td>0</td><td>9</td>");
  expect(page).toContain("<td>0 / 2</td>");
  expect(page).toContain("$0.0000 / $4.0000");
  expect(page).toContain("$— / $2.0000");
});
