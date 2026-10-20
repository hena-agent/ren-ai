import { PersonaError, personaImages } from "@ren-ai/personas";
import type { PersonaStore, PersonaRecord } from "@ren-ai/personas";
import type { Draft } from "./draft.ts";
import type { ImageStage } from "./image-generation.ts";
import type { ProfileGenerator } from "./generation.ts";
import type { ImageSlot } from "./image-slots.ts";
import { characterOf } from "./authoring.ts";
import { readPortraitReference } from "./portrait-images.ts";
import { ownedImageKey } from "@ren-ai/personas/image-url";
import { operation } from "./logging.ts";

export function requireSheetReferences(draft: Draft, slots: readonly ImageSlot[]) {
  for (const { style } of slots) {
    const url = draft.sheets?.[style];
    if (!url) throw new PersonaError("invalid", "이 스타일의 인물 시트를 먼저 만들어 주세요.");
    if (!ownedImageKey(url))
      throw new PersonaError("invalid", "서비스 소유 인물 시트만 사용할 수 있습니다.");
  }
}

export function sheetSource(
  persona: PersonaRecord,
  style: ImageSlot["style"],
  params: URLSearchParams,
) {
  const source = params.get("image");
  if (source === null) return undefined;
  if (
    !ownedImageKey(source) ||
    !personaImages(persona).some((image) => image.style === style && image.imageUrl === source)
  )
    throw new PersonaError("invalid", "같은 스타일의 기존 사진을 선택해 주세요.");
  return source;
}

export async function assertSheets(store: PersonaStore, draft: Draft, slots: readonly ImageSlot[]) {
  const current = await operation("identity.sheets.read", {}, () => store.sheets(draft.id));
  for (const { style } of slots) {
    if (current[style] !== draft.sheets?.[style])
      throw new PersonaError("conflict", "인물 시트가 변경되었습니다. 다시 열어 주세요.");
  }
}

export async function generateSheet(
  persona: PersonaRecord,
  draft: Draft,
  style: ImageSlot["style"],
  prompt: string,
  source: string | undefined,
  generator: ProfileGenerator,
  store: PersonaStore,
  stage: (stage: ImageStage) => void | Promise<void>,
  operationId: string,
) {
  const completed = await operation("identity.sheet.receipt", { style }, () =>
    store.sheetResult(persona.id, style, operationId),
  );
  if (completed)
    return { ...draft, sheets: { ...draft.sheets, [style]: completed }, imageEditing: true };
  const url = source ?? draft.sheets?.[style];
  const reference = url ? await readPortraitReference(url, style, store) : undefined;
  await stage("generating");
  const image = await operation("identity.sheet.generate", { style }, () =>
    generator.sheet(characterOf(persona), style, prompt, reference),
  );
  await stage("saving");
  const imageUrl = await operation("image.save", { style }, () => store.saveImage(image));
  await operation("identity.sheet.save", { style }, () =>
    store.saveSheet(persona.id, style, imageUrl, draft.sheets?.[style], operationId),
  );
  return { ...draft, sheets: { ...draft.sheets, [style]: imageUrl }, imageEditing: true };
}
