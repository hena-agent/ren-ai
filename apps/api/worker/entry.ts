import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
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
import { monitorObject } from "../src/health-monitor.ts";
import {
  applicationWakes,
  finishApplicationWork,
  isStoreWork,
  nextApplicationWake,
  safetyInterval,
  scheduledApplicationWork,
} from "../src/scheduling.ts";
import type { WorkOutcome } from "../src/scheduling.ts";

interface ApplicationNamespace {
  idFromName: (name: string) => DurableObjectId;
  get: (id: DurableObjectId) => { fetch: (request: Request) => Promise<Response> };
}

interface Environment extends CloudflareBindings {
  readonly APPLICATION: ApplicationNamespace;
  readonly ACTIVITY: ApplicationNamespace;
  readonly MONITOR: ApplicationNamespace;
  readonly ACTIVITY_LIMIT?: { limit: (input: { key: string }) => Promise<{ success: boolean }> };
}

const applicationObject = (env: Environment) =>
  env.APPLICATION.get(env.APPLICATION.idFromName("ren-ai-application"));

export class DiscoveryActivity extends DurableObject<Environment> {
  private handler = activityHandler(this.ctx.storage);
  override fetch(request: Request) {
    return this.handler(request);
  }
}

export class HealthMonitor extends DurableObject<Environment> {
  private monitor = monitorObject(
    {
      get: (key) => this.ctx.storage.get<string>(key),
      put: (key, value) => this.ctx.storage.put(key, value),
      getAlarm: () => this.ctx.storage.getAlarm(),
      setAlarm: (time) => this.ctx.storage.setAlarm(time),
    },
    this.env,
    () => applicationObject(this.env),
  );
  override fetch() {
    return Effect.runPromise(this.monitor.ensure);
  }
  async alarm() {
    await Effect.runPromise(this.monitor.alarm);
  }
}

export class ApiApplication extends DurableObject<Environment> {
  private applicationPromise: ReturnType<typeof createCloudflareApplication> | undefined;
  private monitored: Promise<void> | undefined;

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

  /** Each actor starts the health monitor's schedule once; the monitor then keeps its own. */
  private monitor() {
    // A missing or failing monitor never fails the application's own request.
    this.monitored ??= (async () => {
      const started = performance.now();
      try {
        const response = await this.env.MONITOR.get(
          this.env.MONITOR.idFromName("ren-ai-health"),
        ).fetch(new Request("https://monitor/ensure", { method: "POST" }));
        if (response.status !== 204) throw new Error(`Health monitor returned ${response.status}`);
      } catch (cause) {
        this.monitored = undefined;
        contactLog({
          requestId: randomUUID(),
          operation: "api-app.health",
          stage: "monitor.ensure",
          outcome: "failed",
          durationMs: performance.now() - started,
          level: "error",
          ...contactCause(cause),
        });
      }
    })();
  }

  override async fetch(request: Request) {
    const application = await this.application();
    const response = await application.fetch(request);
    if (!application.configuration.bootstrapOnly) {
      this.monitor();
      await this.arm();
    }
    return response;
  }

  /** A request can only bring the next wake forward. */
  private async arm() {
    const due = await (await this.application()).store.run(nextApplicationWake);
    if (due === undefined) return;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || due < alarm) await this.ctx.storage.setAlarm(due);
  }

  /** After an alarm, the next wake is exactly the earliest persisted deadline; idle means none. */
  private async rearm() {
    const due = await (await this.application()).store.run(nextApplicationWake);
    if (due === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(due);
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
      this.monitor();
      const application = await this.application();
      await application.store.run(expireSubmissionLimits(Date.now()));
      const execution = (await application.store.run(applicationWakes)).execution <= Date.now();
      const due = await application.store.run(scheduledApplicationWork);
      // Execution held by its backoff must keep its work for the retry that resumes it.
      work = execution ? due : due.filter((entry) => isStoreWork(entry.name));
      await application.tick(requestId, execution);
      await application.store.run(
        finishApplicationWork(work, execution ? "completed" : "store-only"),
      );
      await this.rearm();
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
      const outcome: WorkOutcome =
        cause instanceof DeferredWork
          ? "deferred"
          : cause instanceof WorkLaneFailure
            ? "completed"
            : "failed";
      try {
        const application = await this.application();
        await application.store.run(finishApplicationWork(work, outcome));
        await this.rearm();
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
    return applicationTransport(request, () => applicationObject(env).fetch(request));
  },
};
