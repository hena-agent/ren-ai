import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { PersonaError, validateID } from "./model.ts";
import { ownedImageKey } from "./image-url.ts";

export const IdentitySheets = Schema.Struct({
  anime: Schema.optionalKey(Schema.String),
  photo: Schema.optionalKey(Schema.String),
});
export type IdentitySheets = typeof IdentitySheets.Type;
export type PortraitStyle = keyof IdentitySheets;
const SheetRecord = Schema.Struct({ sheets: IdentitySheets, operations: IdentitySheets });

/** Authoring references are separate from Persona documents and public photos. */
export function identitySheetFiles(directory: string) {
  const root = join(directory, "identity-sheets");
  const busy = new Set<string>();
  const read = async (id: string) => {
    validateID(id);
    const content = await readFile(join(root, `${id}.json`), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return '{"sheets":{},"operations":{}}';
        throw error;
      },
    );
    return Schema.decodeUnknownSync(SheetRecord)(JSON.parse(content));
  };
  return {
    sheets: async (id: string): Promise<IdentitySheets> => (await read(id)).sheets,
    sheetResult: async (id: string, style: PortraitStyle, operationId: string) => {
      const current = await read(id);
      return current.operations[style] === operationId ? current.sheets[style] : undefined;
    },
    clearSheets: async (id: string) => {
      validateID(id);
      if (busy.has(id)) throw new PersonaError("conflict", "인물 시트를 저장 중입니다.");
      busy.add(id);
      try {
        await rm(join(root, `${id}.json`), { force: true });
      } finally {
        busy.delete(id);
      }
    },
    saveSheet: async (
      id: string,
      style: PortraitStyle,
      imageUrl: string,
      expected?: string,
      operationId: string = randomUUID(),
    ) => {
      validateID(id);
      if (!ownedImageKey(imageUrl))
        throw new PersonaError("invalid", "서비스 소유 인물 시트만 사용할 수 있습니다.");
      if (busy.has(id)) throw new PersonaError("conflict", "인물 시트를 저장 중입니다.");
      busy.add(id);
      const temporary = join(root, randomUUID());
      try {
        const current = await read(id);
        if (current.sheets[style] !== expected)
          throw new PersonaError("conflict", "인물 시트가 변경되었습니다. 다시 열어 주세요.");
        await mkdir(root, { recursive: true });
        await writeFile(
          temporary,
          JSON.stringify({
            sheets: { ...current.sheets, [style]: imageUrl },
            operations: { ...current.operations, [style]: operationId },
          }),
        );
        await rename(temporary, join(root, `${id}.json`));
      } finally {
        busy.delete(id);
        await rm(temporary, { force: true });
      }
    },
  };
}
