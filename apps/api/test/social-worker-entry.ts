import { DurableObject } from "cloudflare:workers";
import { createSocial } from "../src/social/http.ts";

interface Namespace {
  idFromName: (name: string) => import("@cloudflare/workers-types").DurableObjectId;
  get: (id: import("@cloudflare/workers-types").DurableObjectId) => {
    fetch: (request: Request) => Promise<Response>;
  };
}
export class SocialProof extends DurableObject<{ SOCIAL: Namespace }> {
  private social = createSocial(this.ctx.storage, {
    token: "secret",
    now: Date.now,
    personas: async () => new Set(["alice", "bob"]),
    invitation: async () => true,
    start: async (run) => {
      await this.ctx.storage.put("last-run", run.id);
    },
    cancel: async () => {},
    open: async () => {},
    browser: async (_run, _account, action) => {
      if (action.kind === "post") {
        const count = (await this.ctx.storage.get<number>("writes")) ?? 0;
        await this.ctx.storage.put("writes", count + 1);
        throw new Error("Browser disconnected after submission");
      }
      return { text: "public observation" };
    },
  });
  override async fetch(request: Request) {
    if (new URL(request.url).pathname === "/__tick") {
      await this.social.alarm();
      return Response.json({ runId: await this.ctx.storage.get<string>("last-run") });
    }
    if (new URL(request.url).pathname === "/__proof")
      return Response.json({
        writes: await this.ctx.storage.get<number>("writes"),
        plans: this.ctx.storage.sql
          .exec(
            "EXPLAIN QUERY PLAN SELECT kind FROM social_event WHERE account_id='first' AND generation=1 AND contact IS NULL ORDER BY id DESC LIMIT 10",
          )
          .toArray(),
      });
    return this.social.fetch(request);
  }
  async alarm() {
    await this.social.alarm();
  }
}
export default {
  fetch: (request: Request, env: { SOCIAL: Namespace }) =>
    env.SOCIAL.get(env.SOCIAL.idFromName("proof")).fetch(request),
};
