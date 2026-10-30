import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { expect, test } from "vitest";
import { SocialSnapshot } from "@ren-ai/onboarding/social";
import { socialAccount } from "../../../packages/onboarding/src/social.test-helper.ts";

test("real Durable Object SQLite preserves bounded history and uncertain sends across runtime replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "social-durable-"));
  const bundle = await build({
    entryPoints: [new URL("../test/social-worker-entry.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker"],
    mainFields: ["module", "main"],
    external: ["cloudflare:workers", "node:*"],
    target: "es2023",
  });
  const start = () =>
    new Miniflare({
      resourcePersistencePath: root,
      workers: [
        {
          config: {
            name: "social-proof",
            compatibilityDate: "2026-10-13",
            compatibilityFlags: ["nodejs_compat"],
            exports: { SocialProof: { type: "durable-object", storage: "sqlite" } },
            manifest: {
              mainModule: "social.js",
              modules: { "social.js": { type: "esm", contents: bundle.outputFiles[0]!.text } },
            },
            env: {
              SOCIAL: { type: "durable-object", worker: "social-proof", exportName: "SocialProof" },
            },
          },
        },
      ],
    });
  let runtime = start();
  const request = (path: string, body?: object) =>
    runtime.dispatchFetch(`https://proof${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      ...(body && { body: JSON.stringify(body) }),
    });
  try {
    expect(
      (
        await request("/management/social/accounts", {
          ...socialAccount,
          enabled: true,
          startHour: 0,
          endHour: 24,
        })
      ).status,
    ).toBe(200);
    const run = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }))(
      await (await request("/__tick")).json(),
    );
    for (let step = 0; step < 60; step++)
      expect(
        (
          await request("/management/social/actions", {
            runId: run.runId,
            step,
            decision: { action: { kind: "search", query: `topic ${step}` }, reason: "Discovery" },
          })
        ).status,
      ).toBe(200);
    const send = {
      runId: run.runId,
      step: 60,
      decision: { action: { kind: "post", text: "A thought" }, reason: "Share" },
    };
    expect((await request("/management/social/actions", send)).status).toBe(503);
    await runtime.dispose();
    runtime = start();
    expect((await request("/management/social/actions", send)).status).toBe(409);
    const snapshot = Schema.decodeUnknownSync(SocialSnapshot)(
      await (await request("/management/social")).json(),
    );
    expect(snapshot.events).toHaveLength(50);
    expect(snapshot.events[0]?.state).toBe("uncertain");
    const older = Schema.decodeUnknownSync(SocialSnapshot)(
      await (await request(`/management/social?before=${snapshot.before}`)).json(),
    );
    expect(older.events).toHaveLength(11);
    const proof = Schema.decodeUnknownSync(
      Schema.Struct({
        writes: Schema.Number,
        plans: Schema.Array(Schema.Struct({ detail: Schema.String })),
      }),
    )(await (await request("/__proof")).json());
    expect(proof.writes).toBe(1);
    expect(proof.plans.map((plan) => plan.detail).join(" ")).toContain("social_scope_events");
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
