import { DurableObject } from "cloudflare:workers";
import { createCloudflareApplication } from "../src/cloudflare-app.ts";
import type { CloudflareBindings } from "../src/cloudflare-config.ts";
import groundRules from "@ren-ai/plugin-session-folder/ground-rules";
import { contactCause, contactLog } from "../src/discovery/diagnostics.ts";
import { randomUUID } from "node:crypto";
import type { DurableObjectId } from "@cloudflare/workers-types";
import { applicationTransport } from "../src/application-transport.ts";

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
      await this.ctx.storage.setAlarm(Date.now() + 1);
    return application.fetch(request);
  }

  async alarm() {
    const start = performance.now();
    const requestId = randomUUID();
    if (this.env.BOOTSTRAP_ONLY !== "false") return;
    await this.ctx.storage.setAlarm(Date.now() + 2000);
    try {
      const application = await this.application();
      await application.tick();
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
      throw cause;
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
