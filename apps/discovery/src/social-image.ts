import type { PublicPersona } from "@ren-ai/onboarding";
import { ownedImageKey } from "@ren-ai/personas/image-url";
import { stylePhotos } from "./image-style.ts";
import type { ImageStyle } from "./image-style.ts";
import { publicOrigin, personaPath, previewVersion } from "./public-routing.ts";
import type { Locale } from "./public-routing.ts";

export interface SocialImage {
  url: string;
  type: string;
  width: number;
  height: number;
  alt: string;
}

export const brandSocialImage: SocialImage = {
  url: `${publicOrigin}/social-ko-v3.png`,
  type: "image/png",
  width: 1200,
  height: 630,
  alt: "RenAI — 일상에, 기다려지는 메시지 하나. iMessage에서 만나는 AI 페르소나.",
};
export function personaPreview(persona: PublicPersona, style: ImageStyle) {
  const source = stylePhotos(persona, style).imageUrl;
  if (!source) return undefined;
  const key = ownedImageKey(source);
  if (!key) throw new Error("Public preview requires an owned gallery photo");
  const photoId = key.slice(0, key.lastIndexOf("."));
  return {
    key,
    url: `${publicOrigin}${personaPath(persona.id)}/og/${style}/${photoId}.${previewVersion}.jpg`,
  };
}

export function socialImage(
  persona: PublicPersona | undefined,
  style: ImageStyle,
  locale: Locale = "ko",
): SocialImage {
  const preview = persona && personaPreview(persona, style);
  if (!preview)
    return {
      ...brandSocialImage,
      url: `${publicOrigin}/social-${locale}-v3.png`,
      alt: {
        ko: "RenAI — 일상에, 기다려지는 메시지 하나. iMessage에서 만나는 AI 페르소나.",
        en: "RenAI — A message to look forward to. Meet AI personas on iMessage.",
        ja: "RenAI — 毎日に、待ち遠しいメッセージを。iMessageで出会うAIペルソナ。",
      }[locale],
    };
  return {
    url: preview.url,
    type: "image/jpeg",
    width: 1200,
    height: 630,
    alt: `${persona.name} — ${
      {
        ko: `${style === "photo" ? "실사" : "애니메"} 스타일의 AI 페르소나 프로필 사진과 RenAI 로고`,
        en: `AI persona in ${style} style with the RenAI logo`,
        ja: `${style === "photo" ? "フォト" : "アニメ"}スタイルのAIペルソナとRenAIのロゴ`,
      }[locale]
    }`,
  };
}
