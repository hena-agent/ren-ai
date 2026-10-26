import { afterEach, expect, test, vi } from "vitest";
import { cloudflareAdmin } from "./cloudflare-admin.ts";
import { cloudflareFixture, databasePersona } from "../test/cloudflare-fixture.ts";
import { character, initialDocuments, portraitImage, request, tokenOf } from "../test/fixtures.ts";
import { memoryStorage } from "../test/memory-storage.ts";
import { captureWorkerLogs } from "../test/worker-logs.ts";
import { catalogDelivery } from "./catalog-delivery.ts";
import { loggedRequest } from "./logging.ts";

afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const { db, bucket, store } = await cloudflareFixture();
  const imageUrl = await store.saveImage(portraitImage);
  await store.save(
    { ...databasePersona, imageUrl, portraits: { photo: imageUrl } },
    initialDocuments,
    { persona: "" },
  );
  const { storage, clearAlarm } = memoryStorage();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const open = () =>
    cloudflareAdmin(
      {
        DB: db,
        IMAGES: bucket,
        ADMIN_PASSWORD: "test-password",
        TOKEN_CATALOG: "catalog-private",
        APPLICATION_API_URL: "https://messaging.test",
        TOKEN_MANAGEMENT: "management-private",
      },
      storage,
    );
  const save = async (
    admin: Awaited<ReturnType<typeof open>>,
    fields: Record<string, string> = {},
  ) => {
    const draft = tokenOf(await (await admin.fetch(request("/personas/harin"))).text());
    return admin.fetch(
      request("/personas/harin", { ...character, draft, intent: "save", ...fields }),
    );
  };
  return { open, save, store, storage, clearAlarm, fetcher };
}

test("only committed edits notify messaging; publication and unpublication use the same path", async () => {
  const { stdout, stderr } = captureWorkerLogs();
  try {
    const { open, save, store, fetcher, clearAlarm } = await setup();
    const admin = await open();
    await admin.fetch(request("/"));
    await admin.fetch(request("/personas/harin"));
    await admin.alarm();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockImplementation(async (input, options) => {
      expect(new URL(input instanceof Request ? input.url : input).href).toBe(
        "https://messaging.test/management/catalog/refresh",
      );
      expect(options?.method).toBe("POST");
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer management-private");
      expect(new Headers(options?.headers).get("x-operation-id")).toMatch(/^[0-9a-f-]{36}$/);
      expect(options?.body).toBeUndefined();
      expect((await store.get("harin")).name).toBe("수정된 이름");
      return new Response(null, { status: 204 });
    });
    expect((await save(admin, { name: "수정된 이름" })).status).toBe(303);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await (await admin.fetch(request("/personas/harin?saved=1"))).text()).not.toContain(
      "적용을 기다리고",
    );
    clearAlarm();
    await admin.alarm();
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await save(admin, { name: "" })).status).toBe(400);
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockImplementation(async () => new Response(null, { status: 204 }));
    expect((await save(admin, { published: "on" })).status).toBe(303);
    expect((await store.get("harin")).published).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await save(admin)).status).toBe(303);
    expect((await store.get("harin")).published).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

test("a failed delivery preserves the saved edit, shows pending, and retries after restart without secrets", async () => {
  const { stdout, stderr } = captureWorkerLogs();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const { open, save, store, storage, clearAlarm, fetcher } = await setup();
    fetcher.mockResolvedValueOnce(
      new Response("management-private private prompt", { status: 503 }),
    );
    let admin = await open();
    const response = await save(admin, { name: "저장 성공" });
    expect(response.status).toBe(303);
    expect((await store.get("harin")).name).toBe("저장 성공");
    expect(await (await admin.fetch(request("/personas/harin?saved=1"))).text()).toContain(
      "적용을 기다리고",
    );
    const logs = stderr.mock.calls.map(([line]) => String(line)).join("");
    expect(logs).toContain(response.headers.get("x-request-id"));
    expect(logs).toContain('"code":"management_response"');
    expect(logs).toContain('"status":503');
    expect(logs).not.toContain("management-private");
    expect(logs).not.toContain("private prompt");
    admin = await open();
    clearAlarm();
    await admin.alarm();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await storage.getAlarm()).toBe(now + 5000);
    clock.mockReturnValue(now + 5000);
    clearAlarm();
    await admin.alarm();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await (await admin.fetch(request("/personas/harin"))).text()).not.toContain(
      "적용을 기다리고",
    );
    clearAlarm();
    await admin.alarm();
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

test("a failed save restores any previous pending change and never sends its own notification", async () => {
  const { storage } = memoryStorage();
  const notify = vi.fn<() => Promise<void>>(async () => {});
  const delivery = catalogDelivery(storage, notify);
  const failure = new Error("commit failed");
  const save = () =>
    loggedRequest(
      request("/personas", {}),
      async () => {
        await delivery.save(async () => {
          throw failure;
        });
        return new Response(null);
      },
      () => {},
    );
  await expect(save()).rejects.toBe(failure);
  expect(await delivery.pending()).toBe(false);
  const previous = { requestId: "older-operation", attempts: 1, due: Date.now() + 60_000 };
  await storage.put("catalog-notification", previous);
  await expect(save()).rejects.toBe(failure);
  expect(await storage.get("catalog-notification")).toEqual(previous);
  expect(notify).not.toHaveBeenCalled();
});
