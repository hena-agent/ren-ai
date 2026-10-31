import { Schema } from "effect";
import { SocialControl, SocialResult, type SocialDecision } from "@ren-ai/onboarding/social";

export interface SocialApplication {
  control: (id: string, turn?: boolean) => Promise<typeof SocialControl.Type>;
  action: (runId: string, step: number, decision: SocialDecision) => Promise<SocialResult>;
  complete: (runId: string, state: "completed" | "failed" | "login_required") => Promise<void>;
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
      });
    return response;
  };
  return {
    control: async (id, turn = false) =>
      Schema.decodeUnknownSync(SocialControl)(
        await (await request(turn ? "turn" : "control", { runId: id })).json(),
      ),
    action: async (runId, step, decision) =>
      Schema.decodeUnknownSync(SocialResult)(
        await (await request("actions", { runId, step, decision })).json(),
      ),
    complete: async (runId, state) => {
      await request("complete", { runId, state });
    },
  };
}
