import { configureImageCount } from "./portrait-count-options.ts";
import copy from "./copy.json";
import { bindImageModelPicker } from "./image-model-picker.ts";
import { bindArtworkLayerDialog, configureArtworkLayers } from "./artwork-layer-dialog.ts";

const artworkCopy = {
  body: {
    title: "속옷 차림 기본 몸 생성",
    confirm: "기본 몸 1장 생성",
    hint: "시트의 인물 정체성을 유지하고 장식 없는 불투명 속옷 차림으로 제작합니다.",
  },
  outfit: {
    title: "의상만 생성",
    confirm: "의상 1장 생성",
    hint: "현재 기본 몸의 자세·비율에 맞춰 옷과 장식만 제작합니다. 선택적으로 의상 방향을 입력하세요.",
  },
  layers: {
    title: "원화 레이어 분리",
    confirm: "레이어 분리 시작",
    hint: "관절 안쪽을 둥글게 연장·겹치고 배경의 인물 잔여 픽셀을 제거하도록 요청합니다. 결과는 반드시 굽힌 자세로 검수하세요.",
  },
  other: {
    title: copy.portraitDialogTitle,
    confirm: copy.portraitDialogConfirm,
    hint: copy.portraitInstructionsHint,
  },
};

function configureArtworkOptions(
  dialog: HTMLDialogElement,
  submitter: HTMLElement,
  intent: string,
) {
  const options = dialog.querySelector<HTMLElement>("[data-rig-model-options]");
  const model = options?.querySelector<HTMLInputElement>('[name="rigArtworkModel"]');
  if (options && model) {
    options.hidden = intent !== "rig-artwork";
    model.disabled = intent !== "rig-artwork";
  }
  const artwork = submitter.dataset["rigArtworkTarget"] === "true";
  const target = submitter.dataset["artworkTarget"] ?? "body";
  dialog.dataset["artworkTarget"] = target;
  const targetInput = dialog.querySelector<HTMLInputElement>("[data-rig-target-input]");
  if (targetInput) targetInput.value = target;
  const layers = submitter.dataset["layerizeTarget"] === "true";
  dialog.dataset["rigArtwork"] = String(artwork || layers);
  dialog.dataset["layerize"] = String(layers);
  configureArtworkLayers(dialog, submitter, layers);
  const text =
    artworkCopy[layers ? "layers" : artwork ? (target === "outfit" ? "outfit" : "body") : "other"];
  const title = dialog.querySelector("#portrait-dialog-title");
  if (title) title.textContent = text.title;
  dialog.querySelector("[data-portrait-confirm]")!.textContent = text.confirm;
  const count = dialog.querySelector<HTMLElement>("[data-image-count-options]");
  if (count) count.hidden = artwork || layers;
  const hint = dialog.querySelector("#portrait-instructions-hint");
  if (hint) hint.textContent = text.hint;
  configureFaceOptions(dialog, submitter);
}

function configureFaceOptions(dialog: HTMLDialogElement, submitter: HTMLElement) {
  let input = dialog.querySelector<HTMLInputElement>('[name="rigFaceAction"]');
  if (!input) {
    input = dialog.ownerDocument.createElement("input");
    input.type = "hidden";
    input.name = "rigFaceAction";
    dialog.append(input);
  }
  input.value = submitter.dataset["rigFaceAction"] ?? "";
  input.disabled = !input.value;
  if (!input.value) return;
  dialog.querySelector("#portrait-dialog-title")!.textContent = "현재 얼굴·표정 편집";
  dialog.querySelector("[data-portrait-confirm]")!.textContent = "얼굴 편집 1장 생성";
  dialog.querySelector("#portrait-instructions-hint")!.textContent =
    "현재 몸은 유지하고 얼굴 확대 이미지를 편집합니다. 원하는 추가 방향을 선택적으로 입력하세요. 결과는 검수 후 부품으로 적용합니다.";
}

function describeTarget(form: HTMLFormElement, dialog: HTMLDialogElement, submitter: HTMLElement) {
  const target = dialog.querySelector("[data-portrait-target]");
  if (!target) return;
  target.replaceChildren();
  const layers = dialog.dataset["layerize"] === "true";
  const reference =
    submitter.dataset["artworkReference"] ??
    form.querySelector<HTMLAnchorElement>(
      layers ? "[data-artwork-original]" : "[data-rig-artwork] [data-artwork-reference]",
    )?.href;
  if (dialog.dataset["rigArtwork"] !== "true" || !reference) {
    target.textContent = submitter.getAttribute("data-portrait-label");
    return;
  }
  const image = form.ownerDocument.createElement("img");
  image.src = reference;
  image.alt = layers
    ? "레이어를 분리할 원본"
    : dialog.dataset["artworkTarget"] === "outfit"
      ? "의상을 맞출 기본 몸"
      : "참조할 애니메 인물 시트";
  target.append(image, submitter.getAttribute("data-portrait-label") ?? "");
}

export function bindPortraitDialog(form: HTMLFormElement) {
  const dialog = form.querySelector<HTMLDialogElement>("[data-portrait-dialog]");
  if (!dialog) return;
  bindImageModelPicker(dialog);
  bindArtworkLayerDialog(dialog);
  const input = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
  let submitter: HTMLElement | null = null;
  let confirmed = false;
  const artworkOptions = dialog.querySelector<HTMLElement>("[data-rig-model-options]");
  const model = artworkOptions?.querySelector<HTMLInputElement>('[name="rigArtworkModel"]');
  model?.addEventListener("change", () => {
    input.value = "";
  });
  form.addEventListener("submit", (event) => {
    if (event.defaultPrevented || confirmed || form.hasAttribute("aria-busy")) return;
    const intent = event.submitter?.getAttribute("value");
    if (
      !intent ||
      ![
        "generate",
        "regenerate",
        "retry-image",
        "sheet",
        "sheets",
        "rig-artwork",
        "rig-layers",
      ].includes(intent)
    )
      return;
    event.preventDefault();
    submitter = event.submitter;
    configureArtworkOptions(dialog, submitter!, intent);
    const key = submitter!.getAttribute("data-portrait-operation") ?? intent;
    if (input.dataset["portraitOperation"] !== key) {
      for (const prompt of dialog.querySelectorAll("textarea")) prompt.value = "";
      input.value = submitter!.getAttribute("data-portrait-prompt") ?? "";
      const count = dialog.querySelector<HTMLSelectElement>('[name="imageCount"]');
      if (count) count.value = "1";
    }
    input.dataset["portraitOperation"] = key;
    describeTarget(form, dialog, submitter!);
    configureImageCount(dialog, submitter!, intent);
    dialog.dispatchEvent(new dialog.ownerDocument.defaultView!.Event("artwork-model-options"));
    dialog.showModal();
    if (intent === "rig-artwork")
      dialog.querySelector<HTMLInputElement>("[data-model-search]")!.focus();
    else input.focus();
  });
  dialog.querySelector("[data-portrait-cancel]")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    const target = submitter?.id ? form.ownerDocument.getElementById(submitter.id) : submitter;
    target?.focus({ preventScroll: true });
  });
  dialog.querySelector("[data-portrait-confirm]")!.addEventListener("click", () => {
    dialog.close();
    confirmed = true;
    const target = form.ownerDocument.createElement("button");
    for (const attribute of submitter!.attributes)
      if (attribute.name !== "id") target.setAttribute(attribute.name, attribute.value);
    target.hidden = true;
    form.append(target);
    try {
      form.requestSubmit(target);
    } finally {
      target.remove();
      confirmed = false;
    }
  });
}
