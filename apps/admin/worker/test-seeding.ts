import { DurableObject } from "cloudflare:workers";
import { cloudflareAdmin } from "../src/cloudflare-admin.ts";
import type { AdminEnv } from "../src/cloudflare-admin.ts";

type ScriptReply = { body: string; status: number };
type ProviderCall = { url: string; body: string };
type SeedingEnv = AdminEnv & { ADMIN: DurableObjectNamespace };

AbortSignal.timeout = () => new AbortController().signal;

// Only the external paid provider and alarm clock are scripted. D1, R2 and DO
// transactions run in workerd, including replacement of the actor between steps.
export class PersonaAdmin extends DurableObject<SeedingEnv> {
  admin?: Awaited<ReturnType<typeof cloudflareAdmin>>;

  override async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/test/script") {
      await this.ctx.storage.put("script", await request.json<ScriptReply[]>());
      return new Response("ok");
    }
    if (path === "/test/calls")
      return Response.json((await this.ctx.storage.get<ProviderCall[]>("calls")) ?? []);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const calls = (await this.ctx.storage.get<ProviderCall[]>("calls")) ?? [];
      calls.push({
        url: url instanceof Request ? url.url : String(url),
        body: typeof options?.body === "string" ? options.body : "",
      });
      await this.ctx.storage.put("calls", calls);
      const script = (await this.ctx.storage.get<ScriptReply[]>("script")) ?? [];
      const reply = script.shift();
      await this.ctx.storage.put("script", script);
      if (!reply) throw new Error("Script exhausted");
      return new Response(reply.body, { status: reply.status });
    };
    try {
      this.admin ??= await cloudflareAdmin(
        { ...this.env, GEMINI_API_KEY: "test-key" },
        this.ctx.storage,
      );
      if (path === "/test/step") {
        await this.admin.alarm();
        return new Response("ok");
      }
      return await this.admin.fetch(request);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  override async alarm() {}
}

export default {
  fetch(request: Request, env: SeedingEnv) {
    return env.ADMIN.getByName("seeding-test").fetch(request);
  },
};
