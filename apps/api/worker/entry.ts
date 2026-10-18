import { DurableObject } from "cloudflare:workers";
import { createCloudflareApplication } from "../src/cloudflare-app.ts";
import type { CloudflareBindings } from "../src/cloudflare-config.ts";
import groundRules from "@ren-ai/plugin-session-folder/ground-rules";
import { contactCause, contactLog } from "../src/discovery/diagnostics.ts";
import { randomUUID } from "node:crypto";
import type { DurableObjectId } from "@cloudflare/workers-types";
import { applicationTransport } from "../src/application-transport.ts";
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
      work = await application.store.run(scheduledApplicationWork);
      await application.tick();
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
        outcome: "failed",
        durationMs: performance.now() - start,
        level: "error",
        ...contactCause(cause),
      });
      try {
        const application = await this.application();
        await application.store.run(finishApplicationWork(work, true));
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
  fetch(request: Request, env: Environment) {
    return applicationTransport(request, () => {
      const id = env.APPLICATION.idFromName("ren-ai-application");
      return env.APPLICATION.get(id).fetch(request);
    });
  },
};
