import { DurableObject } from "cloudflare:workers";
import { cloudflareAdmin } from "../src/cloudflare-admin.ts";
import { catalogHandler } from "../src/catalog-handler.ts";
import { adminRequest } from "../src/admin-request.ts";

/** @extends {DurableObject<import('../src/cloudflare-admin.ts').AdminEnv>} */
export class PersonaAdmin extends DurableObject {
  /** @param {DurableObjectState} ctx @param {import('../src/cloudflare-admin.ts').AdminEnv} env */
  constructor(ctx, env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(() => cloudflareAdmin(env, ctx.storage));
  }
  /** @override @param {Request} request */
  async fetch(request) {
    return (await this.ready).fetch(request);
  }
  /** @override */
  async alarm() {
    return (await this.ready).alarm();
  }
}

export default {
  /** @param {Request} request @param {import('../src/cloudflare-admin.ts').AdminEnv & {ADMIN: DurableObjectNamespace}} env */
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (
      path === "/api/catalog" ||
      path === "/api/personas" ||
      path.startsWith("/discovery/images/")
    )
      return catalogHandler(request, env);
    return adminRequest(request, () => env.ADMIN.getByName("global").fetch(request));
  },
};
