import { Schema } from "effect";
import { SocialResult } from "@ren-ai/onboarding/social";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { catalogClient } from "../personas/catalog.ts";
import type { CloudflareBindings } from "../cloudflare-config.ts";
import { serviceBase } from "../cloudflare-config.ts";
import type { SocialOptions } from "./service.ts";
import { SocialError } from "./service.ts";
import { SocialAuthStatus } from "@ren-ai/onboarding/social-auth";
import { SocialFailure } from "@ren-ai/onboarding/social-diagnostics";
import { socialImageBackend } from "./image-backend.ts";

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
    const base = serviceBase(env.API_MSG_URL);
    let response: Response;
    try {
      response = await fetcher(new URL(`/social${path}`, base), {
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
    } catch (cause) {
      const error = new SocialError(503, "SOCIAL_EXECUTOR_UNAVAILABLE");
      error.cause = cause;
      throw error;
    }
    if (response.status === 423 && path === "/browser") {
      try {
        Schema.decodeUnknownSync(
          Schema.Struct({
            error: Schema.Literal("SOCIAL_AUTH_REQUIRED"),
            status: SocialAuthStatus,
          }),
        )(await response.json());
      } catch {
        throw new SocialError(503, "SOCIAL_AUTH_RESPONSE_INVALID");
      }
      throw new SocialError(423, "SOCIAL_AUTH_REQUIRED");
    }
    if (response.status === 409 && path === "/auth")
      throw new SocialError(409, "SOCIAL_AUTH_CONFLICT");
    if (response.status === 422 && path === "/browser") {
      const failure = Schema.decodeUnknownSync(SocialFailure)(await response.json());
      throw Object.assign(new SocialError(422, failure.error), { diagnostic: failure.diagnostic });
    }
    if (!response.ok)
      throw Object.assign(new SocialError(503, "SOCIAL_EXECUTOR_UNAVAILABLE"), {
        upstreamStatus: response.status,
        requestId: response.headers.get("X-Request-ID"),
      });
    return response;
  };
  const images = socialImageBackend(env, catalog, fetcher);
  return {
    ...(images && { images }),
    gatewayUrl: env.API_MSG_URL,
    authenticate: async (account, command, requestId) => {
      const response = await native("/auth", { account, command }, requestId);
      try {
        return Schema.decodeUnknownSync(SocialAuthStatus)(await response.json());
      } catch {
        throw new SocialError(503, "SOCIAL_AUTH_RESPONSE_INVALID");
      }
    },
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
    open: async (accountId, platform) => {
      await native("/open", { accountId, platform });
    },
    browser: async (run, account, action, id, image) =>
      Schema.decodeUnknownSync(SocialResult)(
        await (
          await native(
            "/browser",
            { run, account, action, id, ...(image && { image }) },
            run.requestId,
          )
        ).json(),
      ),
  };
}
