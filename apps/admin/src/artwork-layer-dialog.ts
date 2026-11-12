import { Schema } from "effect";
import { ArtworkLayerOptions } from "./artwork-layer-model.ts";

const Failure = Schema.Struct({ error: Schema.String });
export function configureArtworkLayers(
  dialog: HTMLDialogElement,
  submitter: HTMLElement,
  layers: boolean,
) {
  for (const key of [
    "layerizeSource",
    "layerizePersona",
    "layerizeRetry",
    "layerizePrice",
    "layerizeCached",
  ])
    dialog.dataset[key] = submitter.dataset[key] ?? "";
  const options = dialog.querySelector<HTMLElement>("[data-layerize-options]");
  if (!options) return;
  options.hidden = !layers;
  options.querySelector<HTMLInputElement>('[name="layerizeQuote"]')!.disabled =
    !layers || dialog.dataset["layerizeRetry"] === "true";
  dialog.querySelector<HTMLTextAreaElement>("textarea")!.readOnly =
    layers && dialog.dataset["layerizeCached"] === "true";
}
export function bindArtworkLayerDialog(dialog: HTMLDialogElement, fetcher = fetch) {
  const options = dialog.querySelector<HTMLElement>("[data-layerize-options]");
  if (!options) return;
  const quote = options.querySelector<HTMLInputElement>('[name="layerizeQuote"]')!;
  const status = options.querySelector<HTMLElement>("[data-layerize-status]")!;
  const price = options.querySelector<HTMLElement>("[data-layerize-price]")!;
  const confirm = dialog.querySelector<HTMLButtonElement>("[data-portrait-confirm]")!;
  let revision = 0;
  dialog.addEventListener("artwork-model-options", () => {
    const observed = ++revision;
    if (options.hidden) return;
    quote.value = "";
    if (dialog.dataset["layerizeRetry"] === "true") {
      price.textContent = dialog.dataset["layerizePrice"]!;
      status.textContent =
        dialog.dataset["layerizeCached"] === "true"
          ? "접수한 분리 작업을 이어받습니다. 추가 생성 없이 결과 조회·저장을 재시도합니다."
          : "이전 결과가 불확실하면 확인한 분리 작업을 다시 호출하며 과금될 수 있습니다.";
      confirm.disabled = false;
      return;
    }
    confirm.disabled = true;
    status.textContent = "fal 레이어 분리 단가를 확인하고 있습니다…";
    price.textContent = "";
    const source = dialog.dataset["layerizeSource"]!;
    const params = new URLSearchParams({ persona: dialog.dataset["layerizePersona"]!, source });
    params.set("target", dialog.dataset["artworkTarget"]!);
    void (async () => {
      try {
        const response = await fetcher(`/artwork-layer-options?${params}`, { cache: "no-store" });
        if (!response.ok)
          throw new Error(Schema.decodeUnknownSync(Failure)(await response.json()).error);
        const result = Schema.decodeUnknownSync(ArtworkLayerOptions)(await response.json());
        if (observed !== revision || options.hidden) return;
        if (result.selection.sourceOperationId !== source)
          throw new Error("원화가 변경되었습니다. 옵션을 다시 열어 주세요.");
        quote.value = result.quote;
        price.textContent = result.selection.price;
        status.textContent = "원화 1장 분리 · 1.5K 요청 · 최대 17개 레이어가 각각 과금됩니다.";
        confirm.disabled = false;
      } catch (cause) {
        if (observed !== revision) return;
        status.textContent =
          cause instanceof Error ? cause.message : "레이어 분리 단가를 확인하지 못했습니다.";
      }
    })();
  });
}
