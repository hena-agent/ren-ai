import { DurableObject } from "cloudflare:workers";
import { applicationRequest } from "../src/application-request.ts";
import { createCloudflareApplication } from "../src/cloudflare-app.ts";
import type { CloudflareBindings } from "../src/cloudflare-config.ts";
import groundRules from "@ren-ai/plugin-session-folder/ground-rules";
import { contactCause, contactLog } from "../src/discovery/diagnostics.ts";
import { randomUUID } from "node:crypto";
import type { DurableObjectId } from "@cloudflare/workers-types";
import { applicationTransport } from "../src/application-transport.ts";
import { DeferredWork, WorkLaneFailure } from "../src/work-budget.ts";
import { expireSubmissionLimits } from "../src/discovery/rate-limit.ts";
import { activityHandler } from "../src/metrics/activity.ts";
import {
  finishApplicationWork,
  nextApplicationWake,
  safetyInterval,
  scheduleWork,
  scheduledApplicationWork,
} from "../src/scheduling.ts";

interface ApplicationNamespace {
  idFromName: (name: string) => DurableObjectId;
  get: (id: DurableObjectId) => { fetch: (request: Request) => Promise<Response> };
}

interface Environment extends CloudflareBindings {
  readonly APPLICATION: ApplicationNamespace;
  readonly ACTIVITY: ApplicationNamespace;
  readonly ACTIVITY_LIMIT?: { limit: (input: { key: string }) => Promise<{ success: boolean }> };
}

export class DiscoveryActivity extends DurableObject<Environment> {
  private handler = activityHandler(this.ctx.storage);
  override fetch(request: Request) {
    return this.handler(request);
  }
}

export class ApiApplication extends DurableObject<Environment> {
  private applicationPromise: ReturnType<typeof createCloudflareApplication> | undefined;

  private application() {
    this.applicationPromise ??= createCloudflareApplication(
      this.ctx.storage,
      this.env,
      groundRules,
    ).catch((cause) => {
      this.applicationPromise = undefined;
      throw cause;
    });
    return this.applicationPromise;
  }

  override async fetch(request: Request) {
    const application = await this.application();
    if (!application.configuration.bootstrapOnly && (await this.ctx.storage.getAlarm()) === null)
      await application.store.run(scheduleWork("maintenance", Date.now() + safetyInterval));
    const response = await application.fetch(request);
    if (!application.configuration.bootstrapOnly) {
      await this.arm();
    }
    return response;
  }

  private async arm() {
    const due = await (await this.application()).store.run(nextApplicationWake);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || due < alarm) await this.ctx.storage.setAlarm(due);
  }

  async alarm() {
    const start = performance.now();
    const requestId = randomUUID();
    if (this.env.BOOTSTRAP_ONLY !== "false") return;
    const started = Date.now();
    let work: ReadonlyArray<{ name: string; generation: number }> = [];
    try {
      // Persist recovery before I/O so an eviction cannot lose pending work.
      await this.ctx.storage.setAlarm(started + safetyInterval);
      const application = await this.application();
      await application.store.run(expireSubmissionLimits(Date.now()));
      work = await application.store.run(scheduledApplicationWork);
      await application.tick(requestId);
      await application.store.run(finishApplicationWork(work, false));
      await this.arm();
      contactLog({
        requestId,
        operation: "api-app.heartbeat",
        stage: "heartbeat",
        outcome: "completed",
        durationMs: performance.now() - start,
        level: "info",
      });
    } catch (cause) {
      contactLog({
        requestId,
        operation: "api-app.heartbeat",
        stage: "heartbeat",
        outcome: cause instanceof DeferredWork ? "completed" : "failed",
        durationMs: performance.now() - start,
        level: cause instanceof DeferredWork ? "info" : "error",
        ...contactCause(cause),
      });
      try {
        const application = await this.application();
        await application.store.run(
          finishApplicationWork(
            work,
            cause instanceof DeferredWork ? "deferred" : !(cause instanceof WorkLaneFailure),
          ),
        );
        await this.arm();
      } catch (recoveryCause) {
        contactLog({
          requestId,
          operation: "api-app.heartbeat",
          stage: "alarm.recovery",
          outcome: "failed",
          durationMs: performance.now() - start,
          level: "error",
          ...contactCause(recoveryCause),
        });
        throw recoveryCause;
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Environment) {
    if (new URL(request.url).pathname === "/discovery/activity") {
      const headers = {
        "Access-Control-Allow-Origin": "https://renai.im",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Expose-Headers": "X-Visit-Country, X-Request-ID",
        "Cache-Control": "no-store",
      };
      const response = await applicationRequest(request, async (incoming) => {
        if (incoming.method === "OPTIONS") return new Response(null, { status: 204 });
        if (incoming.method !== "POST") return new Response(null, { status: 405 });
        if (
          /bot|crawler|spider|preview|ren-ai-deploy|curl|wget/i.test(
            incoming.headers.get("User-Agent") ?? "",
          )
        )
          return new Response(null, { status: 204 });
        if (
          env.ACTIVITY_LIMIT &&
          !(
            await env.ACTIVITY_LIMIT.limit({
              key: incoming.headers.get("CF-Connecting-IP") ?? "unknown",
            })
          ).success
        )
          return new Response(null, { status: 429 });
        const upstream = await env.ACTIVITY.get(env.ACTIVITY.idFromName("ren-ai-activity")).fetch(
          incoming,
        );
        return new Response(upstream.body, upstream);
      });
      for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      return response;
    }
    return applicationTransport(request, () => {
      const id = env.APPLICATION.idFromName("ren-ai-application");
      return env.APPLICATION.get(id).fetch(request);
    });
  },
};
