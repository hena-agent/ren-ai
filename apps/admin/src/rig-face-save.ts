import { randomUUID } from "node:crypto";
import { PersonaError, validatePortrait, type PersonaStore } from "@ren-ai/personas";
import {
  RigFaceRole,
  RigFaceState,
  RigLayerPlane,
  type RigArtworkLayers,
} from "@ren-ai/personas/rig-artwork";
import { Schema, Option } from "effect";
import { imageSize } from "image-size";
import { faceStateAllowed } from "./rig-face.ts";
import { operation } from "./logging.ts";
import { artworkMutationId } from "./artwork-page-source.ts";

async function uploadedFace(form: FormData, previous: RigArtworkLayers, store: PersonaStore) {
  const file = form.get("image");
  if (!(file instanceof File) || file.size === 0 || file.size > 10 * 1024 * 1024)
    throw new PersonaError("invalid", "10MB 이하의 투명 PNG 부품을 선택하세요.");
  const portrait = {
    bytes: new Uint8Array(await file.arrayBuffer()),
    mimeType: "image/png" as const,
  };
  validatePortrait(portrait);
  let size: ReturnType<typeof imageSize>;
  try {
    size = imageSize(portrait.bytes);
  } catch {
    throw new PersonaError("invalid", "읽을 수 있는 PNG 부품을 선택하세요.");
  }
  if (size.width !== previous.width || size.height !== previous.height)
    throw new PersonaError(
      "invalid",
      `부품은 원화와 같은 ${previous.width}×${previous.height}px PNG 캔버스를 사용하세요.`,
    );
  return store.saveImage(portrait);
}

async function changedFaceParts(form: FormData, previous: RigArtworkLayers, store: PersonaStore) {
  const role = Schema.decodeUnknownOption(RigFaceRole)(form.get("role"));
  const state = Schema.decodeUnknownOption(RigFaceState)(form.get("state"));
  if (Option.isNone(role) || Option.isNone(state) || !faceStateAllowed(role.value, state.value))
    throw new PersonaError("invalid", "얼굴 부품과 상태를 확인하세요.");
  const closed = state.value === "closed" || form.get("eyeClosed") === "on";
  if (closed && !role.value.startsWith("eye"))
    throw new PersonaError("invalid", "감긴 눈 표시는 눈 부품에만 지정하세요.");
  const parts = (previous.faceParts ?? []).filter(
    (part) => part.role !== role.value || part.state !== state.value,
  );
  if (form.get("action") === "delete") return parts;
  if (form.get("action") !== "upload") throw new PersonaError("invalid", "저장 작업을 확인하세요.");
  if (parts.length >= 40) throw new PersonaError("invalid", "얼굴 부품은 최대 40장입니다.");
  const imageUrl = await uploadedFace(form, previous, store);
  return [
    ...parts,
    { role: role.value, state: state.value, imageUrl, ...(closed && { closed: true }) },
  ];
}

export async function saveRigFace(
  request: Request,
  url: URL,
  store: PersonaStore,
  locked: (id: string) => boolean,
) {
  const id = artworkMutationId(request, url, "rig-face");
  if (id instanceof Response) return id;
  return operation("rig.face.save", {}, async () => {
    if (locked(id)) throw new PersonaError("conflict", "이미지 작업이 끝난 뒤 저장하세요.");
    const form = await request.formData();
    const artwork = await store.rigArtwork(id);
    const previous = artwork?.layers;
    if (
      !previous ||
      artwork.operationId !== form.get("source") ||
      previous.operationId !== form.get("result")
    )
      throw new PersonaError("conflict", "원화 또는 레이어가 변경되었습니다. 다시 열어 주세요.");
    const intent = form.get("action");
    let faceParts = previous.faceParts ?? [];
    let layers = previous.layers;
    if (intent === "planes") {
      const decoded = previous.layers.map((layer) =>
        Schema.decodeUnknownOption(RigLayerPlane)(form.get(`plane-${layer.zIndex}`)),
      );
      if (decoded.some(Option.isNone))
        throw new PersonaError("invalid", "모든 레이어의 합성 위치를 선택하세요.");
      layers = layers.map((layer, index) => ({
        ...layer,
        plane: Schema.decodeUnknownSync(RigLayerPlane)(form.get(`plane-${layers[index]!.zIndex}`)),
      }));
    } else faceParts = await changedFaceParts(form, previous, store);
    if (locked(id))
      throw new PersonaError("conflict", "이미지 작업이 시작되었습니다. 완료 후 다시 저장하세요.");
    await store.saveRigArtworkLayers(
      id,
      {
        ...previous,
        operationId: randomUUID(),
        generationOperationId: previous.generationOperationId ?? previous.operationId,
        layers,
        faceParts,
      },
      previous.operationId,
    );
    return new Response(null, { status: 303, headers: { Location: `/personas/${id}/rig-test` } });
  });
}
