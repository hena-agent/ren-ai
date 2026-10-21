import { useState } from "react";
import type { PublicPersona } from "@ren-ai/onboarding";
import type { ImageStyle } from "./image-style.ts";
import { readImageStyle } from "./image-style.ts";
import { useCopy } from "./locale.tsx";
import { shareUrl } from "./public-routing.ts";

export function ProfileShare({
  persona,
  imageStyle,
  disabled = false,
}: {
  persona: PublicPersona;
  imageStyle?: ImageStyle | undefined;
  disabled?: boolean;
}) {
  const copy = useCopy().publicProfile;
  const [state, setState] = useState<"idle" | "pending" | "copied" | "failed">("idle");
  async function share() {
    setState("pending");
    const url = shareUrl(persona.id, imageStyle ?? readImageStyle());
    try {
      if (navigator.share) {
        await navigator.share({ title: `${persona.name} — Ren AI`, url });
        setState("idle");
      } else {
        await navigator.clipboard.writeText(url);
        setState("copied");
      }
    } catch (cause) {
      setState(cause instanceof Error && cause.name === "AbortError" ? "idle" : "failed");
    }
  }
  return (
    <div className="profile-share">
      <button type="button" disabled={disabled || state === "pending"} onClick={() => void share()}>
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <path d="M12 16V3m-5 5 5-5 5 5M5 13v7h14v-7" />
        </svg>
        <span>{copy.share}</span>
      </button>
      <output>
        {state === "copied" ? copy.copied : state === "failed" ? copy.shareFailure : ""}
      </output>
    </div>
  );
}
