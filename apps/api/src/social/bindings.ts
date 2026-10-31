import { Schema } from "effect";
import { SocialResult } from "@ren-ai/onboarding/social";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { catalogClient } from "../personas/catalog.ts";
import type { CloudflareBindings } from "../cloudflare-config.ts";
import type { SocialOptions } from "./service.ts";

export function socialBindings(
  env: CloudflareBindings,
  rules: string,
  application: (request: Request) => Promise<Response>,
  fetcher: typeof fetch = fetch,
): SocialOptions {
  const catalog = catalogClient(
    { url: env.PERSONA_CATALOG_URL, token: env.TOKEN_CATALOG ?? "" },
    fetcher,
  );
  const token = env.TOKEN_MANAGEMENT ?? "";
  const native = async (path: string, body: object, operationId?: string) => {
    if (!env.SOCIAL_EXECUTOR_URL) throw new Error("SOCIAL_EXECUTOR_URL is required");
    const base = new URL(env.SOCIAL_EXECUTOR_URL);
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/" ||
      (base.protocol !== "https:" &&
        !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)))
    )
      throw new Error("Invalid social executor origin");
    const response = await fetcher(new URL(path, base), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(operationId && { "X-Operation-ID": operationId }),
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(path === "/browser" ? 55000 : 15000),
    });
    if (!response.ok)
      throw Object.assign(new Error("Social executor request failed"), {
        code: "SOCIAL_EXECUTOR_REQUEST",
        upstreamStatus: response.status,
      });
    return response;
  };
  return {
    token,
    now: Date.now,
    personas: async () => new Set((await catalog.load()).personas.keys()),
    invitation: async (code) => {
      const response = await application(
        new Request(
          `https://application/management/invitation-availability?${new URLSearchParams({ code }).toString()}`,
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      if (!response.ok) throw new Error("Invitation availability is unavailable");
      return Schema.decodeUnknownSync(Schema.Struct({ available: Schema.Boolean }))(
        await response.json(),
      ).available;
    },
    start: async (run, account) => {
      const persona = (await catalog.load()).personas.get(account.personaId);
      if (!persona) throw new Error("Social Persona no longer exists");
      await native(
        "/runs",
        {
          run,
          account,
          snapshot: JSON.stringify(renderSnapshot(persona, rules)),
        },
        run.requestId,
      );
    },
    cancel: async (accountId, runId) => {
      await native("/cancel", { accountId, runId });
    },
    open: async (accountId) => {
      await native("/open", { accountId });
    },
    browser: async (run, account, action, id) =>
      Schema.decodeUnknownSync(SocialResult)(
        await (await native("/browser", { run, account, action, id }, run.requestId)).json(),
      ),
  };
}
