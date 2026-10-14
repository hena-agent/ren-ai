declare module "cloudflare:workers" {
  import type { DurableObjectStorage } from "@cloudflare/workers-types";

  export abstract class DurableObject<Env> {
    protected readonly ctx: { readonly storage: DurableObjectStorage };
    protected readonly env: Env;
    protected constructor(state: { readonly storage: DurableObjectStorage }, env: Env);
    abstract fetch(request: Request): Response | Promise<Response>;
  }
}
