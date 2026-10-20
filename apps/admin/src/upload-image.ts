import { imageSize } from "image-size";
import {
  decodePersona,
  PersonaError,
  personaImages,
  serializePersona,
  validatePortrait,
  withPersonaImages,
} from "@ren-ai/personas";
import type { PersonaRecord, PersonaStore, Portrait } from "@ren-ai/personas";
import { completedImageDraft } from "./draft.ts";
import type { Draft } from "./draft.ts";
import { imageStyle, imageTarget } from "./portrait-images.ts";
import { operation } from "./logging.ts";

async function portraitFile(form: FormData): Promise<Portrait> {
  const file = form.get("image");
  if (!file || typeof file === "string" || file.size > 20_000_000)
    throw new PersonaError("invalid", "20MB 이하의 PNG, JPEG 또는 WebP 사진을 선택하세요.");
  const mimeType = file.type;
  if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp")
    throw new PersonaError("invalid", "PNG, JPEG 또는 WebP 사진이 필요합니다.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const portrait: Portrait = { bytes, mimeType };
  validatePortrait(portrait);
  let dimensions;
  try {
    dimensions = imageSize(bytes);
  } catch {
    throw new PersonaError("invalid", "사진 파일을 읽을 수 없습니다.");
  }
  if (dimensions.width !== 1024 || dimensions.height !== 1280)
    throw new PersonaError("invalid", "사진을 4:5 크롭으로 확인한 뒤 업로드하세요.");
  return portrait;
}

export async function uploadImage(
  form: FormData,
  params: URLSearchParams,
  persona: PersonaRecord,
  draft: Draft,
  store: PersonaStore,
) {
  const style = imageStyle(params);
  const images = personaImages(persona);
  const replacing = params.has("image");
  const target = replacing ? imageTarget(persona, params).url : undefined;
  if (!replacing && images.filter((image) => image.style === style).length >= 6)
    throw new PersonaError("invalid", "스타일별 최대 6장까지 올릴 수 있습니다.");
  const file = await portraitFile(form);
  const imageUrl = await operation("image.upload.save", { style }, () => store.saveImage(file));
  const nextImages = target
    ? images.map((image) =>
        image.style === style && image.imageUrl === target ? { ...image, imageUrl } : image,
      )
    : [...images, { style, imageUrl }];
  const next = decodePersona(withPersonaImages(persona, nextImages));
  return completedImageDraft({ ...draft, preview: serializePersona(next) });
}
