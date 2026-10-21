import { Schema } from "effect";
import { PublicPersona } from "@ren-ai/onboarding";
import { verifyHealth } from "@ren-ai/transport/health";
import { imageSize } from "image-size";
import { socialImage, brandSocialImage } from "./social-image.ts";
import { shareUrl } from "./public-routing.ts";

async function publicProfiles(response: Response) {
  try {
    return Schema.decodeUnknownSync(Schema.Array(PublicPersona))(await response.json());
  } catch {
    throw new Error("Public Catalog preview data is invalid");
  }
}

export async function verifyPreview(base: string, revision: string, fetcher: typeof fetch = fetch) {
  const get = (url: string | URL) =>
    fetcher(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "Ren-AI-Preview-Check/1.0" },
    });
  await verifyHealth(await get(new URL("/health", base)), "discovery", revision);
  const catalog = await get("https://api.renai.im/discovery/personas");
  if (!catalog.ok) throw new Error("Public Catalog preview probe failed");
  const people = await publicProfiles(catalog);
  const verified = [];
  for (const style of ["anime", "photo"] as const) {
    const persona = people.find(
      (person) => socialImage(person, style).url !== brandSocialImage.url,
    );
    if (!persona) continue;
    const image = socialImage(persona, style);
    const profileUrl = new URL(shareUrl(persona.id, style));
    const profile = await get(new URL(`${profileUrl.pathname}${profileUrl.search}`, base));
    if (!profile.ok) throw new Error("Public profile preview probe failed");
    const html = await profile.text();
    const advertised = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];
    if (advertised !== image.url)
      throw new Error("Profile does not advertise its persona rendition");
    const rendition = await get(advertised);
    if (!rendition.ok || rendition.headers.get("content-type") !== "image/jpeg")
      throw new Error("Persona preview is not a public JPEG");
    const bytes = new Uint8Array(await rendition.arrayBuffer());
    const size = imageSize(bytes);
    if (
      size.type !== "jpg" ||
      size.width !== 1200 ||
      size.height !== 630 ||
      bytes.length >= 5_000_000
    )
      throw new Error("Persona preview format or dimensions are invalid");
    verified.push(style);
  }
  if (!verified.length) return { preview: "no_public_photos" };
  return { preview: "verified", styles: verified };
}
