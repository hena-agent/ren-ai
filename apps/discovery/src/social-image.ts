import { imageSize } from "image-size";
import type { PublicPersona } from "@ren-ai/onboarding";
import { withImageStyle } from "./image-style.ts";
import type { ImageStyle } from "./image-style.ts";
import { publicOrigin } from "./public-routing.ts";

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
  alt: "Ren AI — 오직 당신과만, iMessage에서. AI 페르소나와 나누는 일상.",
};
const mimeTypes: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export async function socialImage(
  persona: PublicPersona | undefined,
  style: ImageStyle,
  fetcher: typeof fetch,
  onFailure: (error: Error, stage: string, status: number | undefined) => void,
): Promise<SocialImage> {
  const source = persona && withImageStyle(persona, style).imageUrl;
  if (!source) return brandSocialImage;
  let stage = "image.read";
  let status: number | undefined;
  try {
    const url = new URL(source, "https://api.renai.im").href;
    const response = await fetcher(url, { signal: AbortSignal.timeout(4_000), redirect: "error" });
    status = response.status;
    if (!response.ok) throw new Error("Public image unavailable");
    if (Number(response.headers.get("Content-Length")) > 5_000_000)
      throw new Error("Social image exceeds size limit");
    stage = "image.decode";
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 5_000_000) throw new Error("Social image exceeds size limit");
    const size = imageSize(bytes);
    const type = mimeTypes[String(size.type)];
    if (!type || size.width < 200 || size.height < 200) throw new Error("Unsupported social image");
    return {
      url,
      type,
      width: size.width,
      height: size.height,
      alt: `${persona.name} — ${style === "photo" ? "실사" : "애니메"} 스타일의 AI 페르소나 프로필 사진`,
    };
  } catch (cause) {
    onFailure(cause instanceof Error ? cause : new Error("Social image failure"), stage, status);
    return brandSocialImage;
  }
}
