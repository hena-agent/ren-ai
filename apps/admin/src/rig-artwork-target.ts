import { PersonaError, type RigArtworkImage } from "@ren-ai/personas";

export function artworkTarget(value: FormDataEntryValue | string | null): "body" | "outfit" {
  if (value === null || value === "body") return "body";
  if (value === "outfit") return "outfit";
  throw new PersonaError("invalid", "기본 몸 또는 의상을 선택하세요.");
}

export function artworkAsset(image: RigArtworkImage | undefined, target: "body" | "outfit") {
  return target === "body" ? image : image?.outfit;
}

export function requireRigBody(image: RigArtworkImage | undefined) {
  if (image?.kind !== "body" || !image.layers)
    throw new PersonaError(
      "invalid",
      "속옷 차림의 기본 몸을 만들고 레이어를 분리·검수한 뒤 의상을 제작하세요.",
    );
  return image;
}
