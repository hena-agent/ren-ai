import { Schema } from "effect";
import { SocialControl, SocialResult, type SocialDecision } from "@ren-ai/onboarding/social";
import type { SocialDiagnostic } from "@ren-ai/onboarding/social-diagnostics";
import { SocialImageData } from "@ren-ai/onboarding/social-images";

export interface SocialApplication {
  image: (runId: string, imageId: string) => Promise<SocialImageData>;
  progress: (runId: string, step: number, diagnostic: SocialDiagnostic) => Promise<void>;
  authenticated: (
    account: import("@ren-ai/onboarding/social-auth").SocialAuthAccount,
  ) => Promise<void>;
  control: (id: string, turn?: boolean) => Promise<typeof SocialControl.Type>;
  action: (runId: string, step: number, decision: SocialDecision) => Promise<SocialResult>;
  complete: (
    runId: string,
    state: "completed" | "failed" | "login_required",
    diagnostic?: SocialDiagnostic,
  ) => Promise<void>;
}
export function socialApplication(
  base: string,
  token: string,
  fetcher: typeof fetch = fetch,
): SocialApplication {
  const request = async (path: string, body: object) => {
    const response = await fetcher(new URL(`/management/social/${path}`, base), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
      redirect: "manual",
    });
    if (!response.ok)
      throw Object.assign(new Error("Social application request failed"), {
        code: "SOCIAL_APPLICATION_REQUEST",
        upstreamStatus: response.status,
        requestId: response.headers.get("X-Request-ID"),
      });
    return response;
  };
  return {
    image: async (runId, imageId) =>
      Schema.decodeUnknownSync(SocialImageData)(
        await (await request("image", { runId, imageId })).json(),
      ),
    progress: async (runId, step, diagnostic) => {
      await request("progress", { runId, step, diagnostic });
    },
    authenticated: async (account) => {
      await request("authenticated", account);
    },
    control: async (id, turn = false) =>
      Schema.decodeUnknownSync(SocialControl)(
        await (await request(turn ? "turn" : "control", { runId: id })).json(),
      ),
    action: async (runId, step, decision) =>
      Schema.decodeUnknownSync(SocialResult)(
        await (await request("actions", { runId, step, decision })).json(),
      ),
    complete: async (runId, state, diagnostic) => {
      await request("complete", { runId, state, ...(diagnostic && { diagnostic }) });
    },
  };
}
