import type { D1Database } from "@cloudflare/workers-types";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  PersonaError,
  RigArtworkImage,
  assertOwnedRigLayers,
  type RigArtworkLayers,
  type RigArtworkOutfit,
} from "@ren-ai/personas";
import { Schema } from "effect";
import { rigArtworks } from "./database-schema.ts";
import { imageKey } from "./r2-images.ts";

export function databaseArtwork(binding: D1Database, imageBase: string) {
  const db = drizzle(binding);
  return {
    rigArtwork: async (id: string): Promise<RigArtworkImage | undefined> => {
      const row = await db.select().from(rigArtworks).where(eq(rigArtworks.personaId, id)).get();
      return row
        ? Schema.decodeUnknownSync(RigArtworkImage)({
            model: row.model,
            operationId: row.operationId,
            imageUrl: `${imageBase}${row.objectKey}`,
            ...(row.layersJson && { layers: row.layersJson }),
            ...(row.kind && { kind: row.kind }),
            ...(row.outfitJson && { outfit: row.outfitJson }),
          })
        : undefined;
    },
    saveRigArtwork: async (id: string, image: RigArtworkImage, expected?: string) => {
      if (image.layers) assertOwnedRigLayers(image.layers);
      if (image.outfit) throw new PersonaError("invalid", "의상은 기본 몸에 별도로 저장하세요.");
      const values = {
        objectKey: imageKey(image.imageUrl),
        model: image.model,
        operationId: image.operationId,
        layersJson: image.layers ?? null,
        kind: image.kind ?? null,
        outfitJson: null,
      };
      const mutation =
        expected === undefined
          ? db
              .insert(rigArtworks)
              .values({ personaId: id, ...values })
              .onConflictDoNothing()
          : db
              .update(rigArtworks)
              .set(values)
              .where(and(eq(rigArtworks.personaId, id), eq(rigArtworks.operationId, expected)));
      const result = await mutation.run();
      if (result.meta.changes === 0)
        throw new PersonaError("conflict", "원화가 변경되었습니다. 다시 열어 주세요.");
    },
    saveRigArtworkOutfit: async (id: string, outfit: RigArtworkOutfit, expected?: string) => {
      imageKey(outfit.imageUrl);
      if (outfit.layers) assertOwnedRigLayers(outfit.layers);
      const result = await db
        .update(rigArtworks)
        .set({ outfitJson: outfit })
        .where(
          and(
            eq(rigArtworks.personaId, id),
            eq(rigArtworks.kind, "body"),
            eq(rigArtworks.operationId, outfit.sourceOperationId),
            expected === undefined
              ? isNull(rigArtworks.outfitJson)
              : sql`json_extract(${rigArtworks.outfitJson}, '$.operationId') = ${expected}`,
          ),
        )
        .run();
      if (result.meta.changes === 0)
        throw new PersonaError("conflict", "기본 몸 또는 의상이 변경되었습니다. 다시 열어 주세요.");
    },
    saveRigArtworkLayers: async (
      id: string,
      layers: RigArtworkLayers,
      expected?: string,
      target: "body" | "outfit" = "body",
    ) => {
      assertOwnedRigLayers(layers);
      const outfit = target === "outfit";
      const receipt = outfit
        ? sql`json_extract(${rigArtworks.outfitJson}, '$.operationId')`
        : sql`${rigArtworks.operationId}`;
      const previous = outfit
        ? sql`json_extract(${rigArtworks.outfitJson}, '$.layers.operationId')`
        : sql`json_extract(${rigArtworks.layersJson}, '$.operationId')`;
      const result = await db
        .update(rigArtworks)
        .set(
          outfit
            ? {
                outfitJson: sql`json_set(${rigArtworks.outfitJson}, '$.layers', json(${JSON.stringify(layers)}))`,
              }
            : { layersJson: layers },
        )
        .where(
          and(
            eq(rigArtworks.personaId, id),
            eq(receipt, layers.sourceOperationId),
            expected === undefined ? isNull(previous) : eq(previous, expected),
          ),
        )
        .run();
      if (result.meta.changes === 0)
        throw new PersonaError("conflict", "원화 또는 레이어가 변경되었습니다. 다시 열어 주세요.");
    },
  };
}
