import type { SocialDiagnostic, SocialStage } from "@ren-ai/onboarding/social-diagnostics";
import { socialFailureCause } from "@ren-ai/onboarding/social-diagnostics";
import { buildRevision } from "@ren-ai/transport/health";

export type BrowserObserver = {
  requestId: string;
  progress: (diagnostic: SocialDiagnostic) => Promise<void>;
};
export function browserTrace(observer?: BrowserObserver) {
  const started = Date.now();
  const requestId = observer?.requestId ?? crypto.randomUUID();
  let stage: SocialStage = "opening";
  let submission: SocialDiagnostic["submission"] = "not_attempted";
  let observedPost: string | undefined;
  const diagnostic = (code: string): SocialDiagnostic => ({
    requestId,
    stage,
    submission,
    code,
    at: Date.now(),
    durationMs: Date.now() - started,
    revision: buildRevision(),
    ...(observedPost && { postId: observedPost }),
  });
  return {
    at: async (next: SocialStage, state = submission, postId?: string) => {
      stage = next;
      submission = state;
      observedPost = postId ?? observedPost;
      await observer?.progress(
        diagnostic(state === "verified" ? "SOCIAL_CONFIRMED" : "SOCIAL_IN_PROGRESS"),
      );
    },
    run: async <T>(operation: () => Promise<T>) => {
      try {
        return await operation();
      } catch (cause) {
        const safe = socialFailureCause(cause);
        throw Object.assign(
          cause instanceof Error ? cause : new Error("Browser operation failed"),
          { diagnostic: { ...diagnostic("SOCIAL_BROWSER_FAILED"), ...safe } },
        );
      }
    },
  };
}
export type BrowserTrace = ReturnType<typeof browserTrace>;
