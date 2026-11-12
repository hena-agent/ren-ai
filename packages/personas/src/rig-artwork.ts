import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { PersonaError, validateID } from "./model.ts";
import { ownedImageKey } from "./image-url.ts";
import {
  RigArtworkImage,
  type RigArtworkLayers,
  type RigArtworkOutfit,
} from "./rig-artwork-model.ts";

export function assertOwnedRigLayers(layers: RigArtworkLayers) {
  if (
    [...layers.layers, ...(layers.faceParts ?? []), ...(layers.faceSources ?? [])].some(
      (layer) => !ownedImageKey(layer.imageUrl),
    )
  )
    throw new PersonaError("invalid", "서비스 소유 레이어만 저장할 수 있습니다.");
}

/** One current source artwork per Persona, independent of documents and gallery order. */
export function rigArtworkFiles(directory: string) {
  const root = join(directory, "rig-artworks");
  const busy = new Set<string>();
  const read = async (id: string): Promise<RigArtworkImage | undefined> => {
    validateID(id);
    const content = await readFile(join(root, `${id}.json`), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    return content === undefined
      ? undefined
      : Schema.decodeUnknownSync(RigArtworkImage)(JSON.parse(content));
  };
  const update = async (
    id: string,
    change: (current: RigArtworkImage | undefined) => RigArtworkImage,
  ) => {
    validateID(id);
    if (busy.has(id)) throw new PersonaError("conflict", "원화를 저장 중입니다.");
    busy.add(id);
    const temporary = join(root, randomUUID());
    try {
      const image = change(await read(id));
      await mkdir(root, { recursive: true });
      await writeFile(temporary, JSON.stringify(image));
      await rename(temporary, join(root, `${id}.json`));
    } finally {
      busy.delete(id);
      await rm(temporary, { force: true });
    }
  };
  return {
    rigArtwork: read,
    saveRigArtwork: async (id: string, image: RigArtworkImage, expected?: string) => {
      if (!ownedImageKey(image.imageUrl))
        throw new PersonaError("invalid", "서비스 소유 원화만 사용할 수 있습니다.");
      if (image.layers) assertOwnedRigLayers(image.layers);
      if (image.outfit) throw new PersonaError("invalid", "의상은 기본 몸에 별도로 저장하세요.");
      await update(id, (current) => {
        if (current?.operationId !== expected)
          throw new PersonaError("conflict", "원화가 변경되었습니다. 다시 열어 주세요.");
        return image;
      });
    },
    saveRigArtworkOutfit: async (id: string, outfit: RigArtworkOutfit, expected?: string) => {
      if (!ownedImageKey(outfit.imageUrl))
        throw new PersonaError("invalid", "서비스 소유 의상만 저장할 수 있습니다.");
      if (outfit.layers) assertOwnedRigLayers(outfit.layers);
      await update(id, (current) => {
        if (
          current?.kind !== "body" ||
          current.operationId !== outfit.sourceOperationId ||
          current.outfit?.operationId !== expected
        )
          throw new PersonaError(
            "conflict",
            "기본 몸 또는 의상이 변경되었습니다. 다시 열어 주세요.",
          );
        return { ...current, outfit };
      });
    },
    saveRigArtworkLayers: async (
      id: string,
      layers: RigArtworkLayers,
      expected?: string,
      target: "body" | "outfit" = "body",
    ) => {
      assertOwnedRigLayers(layers);
      await update(id, (current) => {
        const asset = target === "outfit" ? current?.outfit : current;
        if (
          !current ||
          !asset ||
          asset.operationId !== layers.sourceOperationId ||
          asset.layers?.operationId !== expected
        )
          throw new PersonaError(
            "conflict",
            "원화 또는 레이어가 변경되었습니다. 다시 열어 주세요.",
          );
        return target === "outfit"
          ? { ...current, outfit: { ...current.outfit!, layers } }
          : { ...current, layers };
      });
    },
  };
}
