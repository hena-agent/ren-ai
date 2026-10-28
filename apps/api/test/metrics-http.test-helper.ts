import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fromPartial } from "@total-typescript/shoehorn";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { SqliteClient as NodeSqlite } from "@effect/sql-sqlite-node";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vitest";
import { Metrics, discoveryNotice, koreaDay } from "@ren-ai/onboarding";
import { fakeMessages, fakeGestures } from "@ren-ai/imsg/testing";
import { createApplicationStore } from "../src/application-store.ts";
import { activityHandler } from "../src/metrics/activity.ts";
import { applicationRequest } from "../src/application-request.ts";
import { conversations } from "../src/conversations/conversations.ts";
import { makeOperator } from "../src/operator/operator.ts";
import { operatorHandler } from "../src/operator/api.ts";
import { outbox } from "../src/outbox/outbox.ts";
import { authenticatedOperator } from "./operator-http.test-helper.ts";
import type { Webhooks } from "../src/metrics/discord.ts";
import {
  scheduledApplicationWork,
  finishApplicationWork,
  nextApplicationWake,
} from "../src/scheduling.ts";

const paths = vi.hoisted(() => new WeakMap<DurableObjectStorage, string>());
// Exercise application HTTP with real SQLite; the DO harness covers storage budgets and replacement.
vi.mock("@effect/sql-sqlite-do", () => ({
  SqliteClient: {
    layer: ({ storage }: { storage: DurableObjectStorage }) =>
      NodeSqlite.layer({ filename: paths.get(storage)! }),
  },
}));

export async function metricsFixture(
  webhooks: Webhooks = {
    alerts: "https://discord.example/alerts",
    reports: "https://discord.example/reports",
  },
  managementToken = "test",
  network: "injected" | "global" = "injected",
) {
  const root = await mkdtemp(join(tmpdir(), "metrics-http-"));
  const storage = fromPartial<DurableObjectStorage>({});
  const browserStorage = fromPartial<DurableObjectStorage>({});
  paths.set(storage, join(root, "application.sqlite"));
  paths.set(browserStorage, join(root, "activity.sqlite"));
  const browser = activityHandler(browserStorage);
  const activity = vi.fn<(request: Request) => Promise<Response>>(browser);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "accepted" }));
  const catalog = vi.fn<
    () => Promise<{ id: string; name: string; bio: string; imageUrl: string }[]>
  >(async () => [{ id: "sora", name: "Sora", bio: "Public", imageUrl: "" }]);
  const store = await createApplicationStore(storage, {
    catalog,
    turnstileSecret: "test",
    managementToken,
    activity,
    ...(network === "injected" && { fetcher }),
    webhooks,
    httpClient: HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: true }))),
    ),
  });
  const directory = await store.run(conversations);
  const fake = fakeMessages();
  const sends = await store.run(outbox(fake.messages, fakeGestures().gestures, new Map()));
  const operator = operatorHandler({
    ...(await store.run(makeOperator(directory, () => Effect.void))),
    releaseSend: (handle, callID, outcome) =>
      Effect.gen(function* () {
        const conversation = yield* directory.byHandle(handle);
        return conversation
          ? yield* sends.release(conversation, callID, outcome)
          : ("not_found" as const);
      }),
  });
  const operatorWeb = authenticatedOperator(operator.handler, "test");
  const call = (path: string, init?: RequestInit) =>
    applicationRequest(
      new Request(`https://api.test${path}`, init),
      path.startsWith("/operator/") ? operatorWeb : store.handler,
    );
  const day = koreaDay(Date.now());
  const read = async (breakdown = "total") => {
    const response = await call(
      `/management/metrics?from=${day}&to=${day}&breakdown=${breakdown}`,
      { headers: { Authorization: "Bearer test" } },
    );
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(Metrics)(await response.json());
  };
  const register = (handle: string, extra: object = {}) =>
    call("/discovery/waitlist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": handle,
        "CF-IPCountry": "US",
      },
      body: JSON.stringify({
        handle,
        name: "private-name",
        locale: "ko",
        privacyNoticeVersion: discoveryNotice.version,
        turnstileToken: "human",
        likedPersonaIDs: ["sora"],
        ...extra,
      }),
    });
  const mark = (enabled: boolean) =>
    call("/operator/test-handle", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "+821012345678", enabled }),
    });
  const startConversation = async (sessionID: string) => {
    await register("+821012345678");
    const conversation = await store.run(
      directory.create({
        handle: "+821012345678",
        locale: "ko",
        consentVersion: discoveryNotice.version,
        consentLanguage: "ko",
        personaID: "sora",
        sessionID,
      }),
    );
    await store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE conversation SET registration_id = (SELECT id FROM discovery_registration WHERE handle = ${conversation.handle}) WHERE id = ${conversation.id}`;
      }),
    );
    return conversation;
  };
  const release = (callID: string, outcome: "failed" | "delivered" = "failed") =>
    call("/operator/release-send", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "+821012345678", callID, outcome }),
    });
  return {
    store,
    alarm: async () => {
      const work = await store.run(scheduledApplicationWork);
      await store.metricsTick("metrics-alarm");
      await store.run(finishApplicationWork(work, "completed"));
      return store.run(nextApplicationWake);
    },
    call,
    read,
    register,
    mark,
    startConversation,
    release,
    directory,
    fake,
    activity,
    browser,
    fetcher,
    catalog,
    day,
    close: async () => {
      await operator.dispose();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
