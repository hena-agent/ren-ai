import type { ImageModelEntry } from "./image-model.ts";

export function renderImageModels(
  list: HTMLElement,
  entries: readonly ImageModelEntry[],
  provider: string,
  selected: string,
) {
  const visible = entries.filter(
    (entry) =>
      !provider || (provider === "connected" ? entry.connected : entry.provider === provider),
  );
  const document = list.ownerDocument;
  list.replaceChildren();
  for (const entry of visible) {
    const row = document.createElement("label");
    row.className = "model-choice";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "imageModelChoice";
    radio.value = entry.id;
    radio.disabled = Boolean(entry.reason);
    radio.checked = entry.id === selected && !radio.disabled;
    const text = document.createElement("span");
    text.className = "model-choice-text";
    const title = document.createElement("strong");
    title.textContent = entry.name;
    const identity = document.createElement("code");
    identity.textContent = `${entry.providerName} · ${entry.model}`;
    text.append(title, identity);
    if (entry.reason) {
      const reason = document.createElement("small");
      reason.textContent = entry.reason;
      text.append(reason);
    }
    row.append(radio, text);
    list.append(row);
  }
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "model-empty";
    empty.textContent = "표시할 원화 모델이 없습니다. 검색어나 공급자를 변경해 주세요.";
    list.append(empty);
  }
  return visible.some((entry) => entry.id === selected && !entry.reason) ? selected : "";
}
