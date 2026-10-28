import { bindings, controls, fetcher, storage } from "../test/cloudflare-app.test-helper.ts";
import { expect, test } from "vitest";
import { createCloudflareApplication } from "./cloudflare-app.ts";
import { executionBindings } from "../test/execution-bindings.ts";

test("an unconfigured management boundary cannot expose edit baselines or accept wake hints", async () => {
  const app = await createCloudflareApplication(
    storage,
    { ...bindings, TOKEN_MANAGEMENT: "", BOOTSTRAP_ONLY: "false" },
    "rules",
    fetcher,
  );
  try {
    expect((await app.fetch(new Request("https://app/management/intake/watch"))).status).toBe(503);
    for (const path of ["/management/intake/wake", "/management/alerts"])
      expect((await app.fetch(new Request(`https://app${path}`, { method: "POST" }))).status).toBe(
        503,
      );
  } finally {
    await app.close();
  }
});

test("health monitor reports reach the application's alerts without starting execution", async () => {
  const app = await createCloudflareApplication(storage, executionBindings, "rules", fetcher);
  try {
    const response = await app.fetch(
      new Request("https://app/management/alerts", {
        method: "POST",
        headers: { authorization: "Bearer management-secret" },
        body: JSON.stringify({ alerts: [{ name: "screen-locked", raised: true }] }),
      }),
    );
    expect(response.status).toBe(204);
    expect(controls.storeHandler).not.toHaveBeenCalled();
    expect(controls.runtime).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test("store work runs without creating the conversation runtime when no execution is due", async () => {
  const app = await createCloudflareApplication(storage, executionBindings, "rules", fetcher);
  try {
    await app.tick("store-only", false);
    expect(controls.metricsTick).toHaveBeenLastCalledWith("store-only");
    expect(controls.runtime).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
