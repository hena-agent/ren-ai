import { randomUUID } from "node:crypto";
import { PersonaError, type PersonaStore } from "@ren-ai/personas";
import { operation } from "./logging.ts";
import { artworkMutationId } from "./artwork-page-source.ts";
import { artworkTarget, artworkAsset } from "./rig-artwork-target.ts";

export async function saveArtworkLayerLayout(
  request: Request,
  url: URL,
  store: PersonaStore,
  locked: (id: string) => boolean,
) {
  const id = artworkMutationId(request, url, "artwork-layers/layout");
  if (id instanceof Response) return id;
  if (locked(id)) throw new PersonaError("conflict", "이미지 작업이 끝난 뒤 위치를 저장해 주세요.");
  const form = await request.formData();
  const target = artworkTarget(form.get("rigArtworkTarget"));
  const image = artworkAsset(
    await operation("rig.layers.read", {}, () => store.rigArtwork(id)),
    target,
  );
  const previous = image?.layers;
  if (
    !image ||
    !previous ||
    image.operationId !== form.get("source") ||
    previous.operationId !== form.get("result")
  )
    throw new PersonaError("conflict", "원화 또는 레이어가 변경되었습니다. 다시 열어 주세요.");
  const values = ["layer", "x", "y", "width", "height"].map((name) => {
    const value = form.get(name);
    if (typeof value !== "string" || !value.trim())
      throw new PersonaError("invalid", "레이어와 위치·크기를 확인하세요.");
    return Number(value);
  });
  const [index, x, y, width, height] = values;
  if (
    values.some((value) => !Number.isFinite(value)) ||
    !Number.isInteger(index) ||
    index! <= 0 ||
    !previous.layers.some((layer) => layer.zIndex === index) ||
    x! < 0 ||
    y! < 0 ||
    width! <= 0 ||
    height! <= 0 ||
    x! + width! > previous.width ||
    y! + height! > previous.height
  )
    throw new PersonaError("invalid", "레이어의 위치·크기는 원화 범위 안에 있어야 합니다.");
  const layers = {
    ...previous,
    operationId: randomUUID(),
    generationOperationId: previous.generationOperationId ?? previous.operationId,
    layers: previous.layers.map((layer) =>
      layer.zIndex === index
        ? { ...layer, bounds: [x!, y!, x! + width!, y! + height!] as const }
        : layer,
    ),
  };
  await operation("rig.layers.layout", {}, () =>
    store.saveRigArtworkLayers(id, layers, previous.operationId, target),
  );
  return new Response(null, {
    status: 303,
    headers: { Location: `/personas/${id}/artwork-layers?layout=saved&target=${target}` },
  });
}
