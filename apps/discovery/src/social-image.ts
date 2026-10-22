import type { PublicPersona } from "@ren-ai/onboarding";
import { ownedImageKey } from "@ren-ai/personas/image-url";
import { withImageStyle } from "./image-style.ts";
import type { ImageStyle } from "./image-style.ts";
import { publicOrigin, personaPath, previewVersion } from "./public-routing.ts";

export interface SocialImage {
  url: string;
  type: string;
  width: number;
  height: number;
  alt: string;
}

export const brandSocialImage: SocialImage = {
  url: `${publicOrigin}/social.png`,
  type: "image/png",
  width: 1200,
  height: 630,
  alt: "Ren AI — iMessage에서. AI 페르소나와 나누는 일상.",
};
export function personaPreview(persona: PublicPersona, style: ImageStyle) {
  const source = withImageStyle(persona, style).imageUrl;
  if (!source) return undefined;
  const key = ownedImageKey(source);
  if (!key) throw new Error("Public preview requires an owned gallery photo");
  const photoId = key.slice(0, key.lastIndexOf("."));
  return {
    key,
    url: `${publicOrigin}${personaPath(persona.id)}/og/${style}/${photoId}.${previewVersion}.jpg`,
  };
}

export function socialImage(persona: PublicPersona | undefined, style: ImageStyle): SocialImage {
  const preview = persona && personaPreview(persona, style);
  if (!preview) return brandSocialImage;
  return {
    url: preview.url,
    type: "image/jpeg",
    width: 1200,
    height: 630,
    alt: `${persona.name} — ${style === "photo" ? "실사" : "애니메"} 스타일의 AI 페르소나 프로필 사진과 Ren AI 로고`,
  };
}
