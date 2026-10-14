import { DurableObject } from "cloudflare:workers";
import { createCloudflareApplication } from "../src/cloudflare-app.ts";
import type { CloudflareBindings } from "../src/cloudflare-config.ts";

interface ApplicationNamespace {
  idFromName: (name: string) => string;
  get: (id: string) => { fetch: (request: Request) => Promise<Response> };
}

interface Environment extends CloudflareBindings {
  readonly APPLICATION: ApplicationNamespace;
}

export class ApiApplication extends DurableObject<Environment> {
  private applicationPromise: ReturnType<typeof createCloudflareApplication> | undefined;

  private application() {
    this.applicationPromise ??= createCloudflareApplication(this.ctx.storage, this.env);
    return this.applicationPromise;
  }

  override async fetch(request: Request) {
    return (await this.application()).fetch(request);
  }
}

export default {
  fetch(request: Request, env: Environment) {
    const id = env.APPLICATION.idFromName("ren-ai-application");
    return env.APPLICATION.get(id).fetch(request);
  },
};
