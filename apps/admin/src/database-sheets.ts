import type { D1Database } from "@cloudflare/workers-types";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { PersonaError } from "@ren-ai/personas";
import type { IdentitySheets } from "@ren-ai/personas";
import { identitySheets } from "./database-schema.ts";
import { imageKey } from "./r2-images.ts";

export function databaseSheets(binding: D1Database, imageBase: string) {
  const db = drizzle(binding);
  return {
    sheets: async (id: string): Promise<IdentitySheets> => {
      const rows = await db.select().from(identitySheets).where(eq(identitySheets.personaId, id));
      return Object.fromEntries(rows.map((row) => [row.style, `${imageBase}${row.objectKey}`]));
    },
    sheetResult: async (id: string, style: keyof IdentitySheets, operationId: string) => {
      const row = await db
        .select()
        .from(identitySheets)
        .where(
          and(
            eq(identitySheets.personaId, id),
            eq(identitySheets.style, style),
            eq(identitySheets.operationId, operationId),
          ),
        )
        .get();
      return row ? `${imageBase}${row.objectKey}` : undefined;
    },
    clearSheets: async (id: string) => {
      await db.delete(identitySheets).where(eq(identitySheets.personaId, id));
    },
    saveSheet: async (
      id: string,
      style: keyof IdentitySheets,
      imageUrl: string,
      expected?: string,
      operationId: string = crypto.randomUUID(),
    ) => {
      const objectKey = imageKey(imageUrl);
      const mutation =
        expected === undefined
          ? db
              .insert(identitySheets)
              .values({ personaId: id, style, objectKey, operationId })
              .onConflictDoNothing()
          : db
              .update(identitySheets)
              .set({ objectKey, operationId })
              .where(
                and(
                  eq(identitySheets.personaId, id),
                  eq(identitySheets.style, style),
                  eq(identitySheets.objectKey, imageKey(expected)),
                ),
              );
      const result = await mutation.run();
      if (result.meta.changes === 0)
        throw new PersonaError("conflict", "인물 시트가 변경되었습니다. 다시 열어 주세요.");
    },
  };
}
