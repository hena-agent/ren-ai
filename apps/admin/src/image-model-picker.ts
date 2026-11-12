import { Schema } from "effect";
import { ImageModelPage, ImageModelSelection, type ImageModelEntry } from "./image-model.ts";
import { renderImageModels } from "./image-model-list.ts";

const Detail = Schema.Struct({ selection: ImageModelSelection, quote: Schema.String });
const Failure = Schema.Struct({ error: Schema.String });

async function catalogFetch<T>(url: string, codec: Schema.Codec<T>, fetcher: typeof fetch) {
  const response = await fetcher(url, { cache: "no-store" });
  if (!response.ok) {
    const error = await response.json().then(Schema.decodeUnknownSync(Failure));
    throw new Error(error.error);
  }
  return response.json().then(Schema.decodeUnknownSync(codec));
}

export function bindImageModelPicker(dialog: HTMLDialogElement, fetcher = fetch) {
  const region = dialog.querySelector<HTMLElement>("[data-rig-model-options]");
  if (!region) return;
  const makeOption = (label: string, value: string) => {
    const option = dialog.ownerDocument.createElement("option");
    option.textContent = label;
    option.value = value;
    return option;
  };
  const model = region.querySelector<HTMLInputElement>('[name="rigArtworkModel"]')!;
  const list = region.querySelector<HTMLElement>("[data-model-list]")!;
  const quote = region.querySelector<HTMLInputElement>('[name="rigArtworkQuote"]')!;
  const search = region.querySelector<HTMLInputElement>("[data-model-search]")!;
  const provider = region.querySelector<HTMLSelectElement>("[data-model-provider]")!;
  const status = region.querySelector<HTMLOutputElement>("[data-model-status]")!;
  const errors = region.querySelector<HTMLElement>("[data-model-errors]")!;
  const price = region.querySelector<HTMLElement>("[data-model-price]")!;
  const confirm = dialog.querySelector<HTMLButtonElement>("[data-portrait-confirm]")!;
  const more = region.querySelector<HTMLButtonElement>("[data-model-more]")!;
  let entries: ImageModelEntry[] = [];
  let cursor: string | null = null;
  let ready = false;
  let listRevision = 0;
  let choiceRevision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const blocked = () => {
    quote.value = "";
    confirm.disabled = true;
    price.textContent = "모델을 선택하면 단가를 확인합니다.";
  };
  const display = () => {
    model.value = renderImageModels(list, entries, provider.value, model.value);
    if (!model.value) blocked();
  };
  const providers = () => {
    const selected = provider.value;
    provider.replaceChildren(
      makeOption("모든 공급자", ""),
      makeOption("연결된 공급자", "connected"),
    );
    const names = new Map(entries.map((entry) => [entry.provider, entry.providerName]));
    for (const [id, name] of names) provider.add(makeOption(name, id));
    provider.value = names.has(selected) || selected === "connected" ? selected : "";
    if (!ready && selected === "connected" && !model.dataset["initialModel"]) {
      const connected = new Set(
        entries.filter((entry) => entry.connected && !entry.reason).map((entry) => entry.provider),
      );
      if (connected.size === 1) provider.value = connected.values().next().value!;
    }
  };
  const resolve = async (id: string) => {
    const observed = ++choiceRevision;
    blocked();
    if (!id) return;
    status.textContent = "참조 이미지 지원·현재 단가를 확인하고 있습니다.";
    try {
      const result = await catalogFetch(
        `/image-models?${new URLSearchParams({ model: id })}`,
        Detail,
        fetcher,
      );
      if (observed !== choiceRevision || region.hidden) return;
      if (result.selection.id !== id) throw new Error("조회한 모델이 선택과 일치하지 않습니다.");
      model.value = id;
      if (!entries.some((entry) => entry.id === id)) {
        entries.push({ ...result.selection, releaseDate: "", connected: true, reason: "" });
        display();
      }
      for (const radio of list.querySelectorAll<HTMLInputElement>("input"))
        radio.checked = radio.value === id;
      quote.value = result.quote;
      model.dataset["initialModel"] = id;
      price.textContent = `${result.selection.price} · 조회 ${new Date(result.selection.observedAt).toLocaleString()}`;
      status.textContent = "시트 참조 확인 · 원화 1장";
      confirm.disabled = false;
    } catch (cause) {
      if (observed !== choiceRevision) return;
      status.textContent = cause instanceof Error ? cause.message : "모델 정보를 읽지 못했습니다.";
    }
  };
  const restoreChoice = async (selected: string) => {
    if (model.value) {
      await resolve(model.value);
      return;
    }
    if (selected && !search.value && (!provider.value || provider.value === "connected"))
      await resolve(selected);
  };
  const load = async (refresh = false, append = false) => {
    const observed = ++listRevision;
    choiceRevision++;
    const selected = model.value || model.dataset["initialModel"] || "";
    blocked();
    list.setAttribute("aria-busy", "true");
    const params = new URLSearchParams({ q: search.value });
    if (refresh) params.set("refresh", "1");
    if (append && cursor) params.set("cursor", cursor);
    status.textContent = "모델 카탈로그를 읽고 있습니다.";
    try {
      const page = await catalogFetch(`/image-models?${params}`, ImageModelPage, fetcher);
      if (observed !== listRevision || !region.isConnected) return;
      entries = append
        ? [...new Map([...entries, ...page.models].map((entry) => [entry.id, entry])).values()]
        : [...page.models];
      cursor = page.nextCursor;
      more.hidden = !cursor;
      providers();
      display();
      ready = true;
      errors.textContent = page.errors.join(" ");
      errors.hidden = page.errors.length === 0;
      status.textContent = `${list.querySelectorAll("input").length}개 모델`;
      await restoreChoice(selected);
    } catch (cause) {
      if (observed !== listRevision) return;
      status.textContent =
        cause instanceof Error ? cause.message : "모델 카탈로그를 읽지 못했습니다.";
    } finally {
      if (observed === listRevision) list.setAttribute("aria-busy", "false");
    }
  };
  model.addEventListener("change", () => {
    void resolve(model.value);
  });
  list.addEventListener("change", (event) => {
    const radio = event.target;
    if (!(radio instanceof dialog.ownerDocument.defaultView!.HTMLInputElement)) return;
    model.value = radio.value;
    model.dispatchEvent(new dialog.ownerDocument.defaultView!.Event("change"));
  });
  provider.addEventListener("change", () => {
    choiceRevision++;
    display();
    if (model.value) void resolve(model.value);
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.preventDefault();
  });
  search.addEventListener("input", () => {
    clearTimeout(timer);
    choiceRevision++;
    blocked();
    timer = setTimeout(() => {
      void load();
    }, 300);
  });
  region.querySelector("[data-model-refresh]")!.addEventListener("click", () => {
    void load(true);
  });
  more.addEventListener("click", () => {
    void load(false, true);
  });
  dialog.addEventListener("artwork-model-options", () => {
    if (region.hidden) {
      confirm.disabled = false;
      return;
    }
    if (!ready) {
      void load();
      return;
    }
    if (!quote.value) {
      confirm.disabled = true;
      const id = model.value || model.dataset["initialModel"] || "";
      if (id) void resolve(id);
    }
  });
}
