import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { useBrowser } from "../test/browser.ts";
import { deferred } from "../test/queue.ts";
import { ImageOptions } from "./image-options.tsx";
import { bindImageModelPicker } from "./image-model-picker.ts";
import { googleModel, openaiModel, routerModel, seedreamModel } from "../test/image-models.ts";
import type { ImageModelSelection } from "./image-model.ts";
import { fetchUrl } from "../test/fetch-url.ts";

useBrowser(() => vi.useRealTimers());

function page(
  models: readonly ImageModelSelection[],
  nextCursor: string | null = null,
  errors: string[] = [],
) {
  return Response.json({
    models: models.map((model) => ({
      id: model.id,
      model: model.model,
      provider: model.provider,
      name: model.name,
      providerName: model.providerName,
      releaseDate: "2026-11-01",
      price: model.price,
      outputFormat: model.outputFormat,
      connected: true,
      reason: "",
    })),
    nextCursor,
    errors,
  });
}
const choice = (model: ImageModelSelection) => Response.json({ selection: model, quote: model.id });
function mount(fetcher: typeof fetch, initialModel?: string) {
  document.body.innerHTML = renderToStaticMarkup(
    <form>
      <ImageOptions artworkModel={initialModel} />
    </form>,
  );
  const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
  const region = dialog.querySelector<HTMLElement>("[data-rig-model-options]")!;
  region.hidden = false;
  const model = region.querySelector<HTMLInputElement>('[name="rigArtworkModel"]')!;
  model.disabled = false;
  bindImageModelPicker(dialog, fetcher);
  dialog.dispatchEvent(new Event("artwork-model-options"));
  return {
    dialog,
    region,
    model,
    quote: region.querySelector<HTMLInputElement>('[name="rigArtworkQuote"]')!,
    confirm: dialog.querySelector<HTMLButtonElement>("[data-portrait-confirm]")!,
    search: region.querySelector<HTMLInputElement>("[data-model-search]")!,
  };
}

const choices = (ui: ReturnType<typeof mount>) => [
  ...ui.region.querySelectorAll<HTMLInputElement>("[data-model-list] input"),
];
function choose(ui: ReturnType<typeof mount>, id: string) {
  choices(ui)
    .find((radio) => radio.value === id)!
    .click();
}
async function chooseSingleEntry(ui: ReturnType<typeof mount>, id: string) {
  await vi.waitFor(() => expect(choices(ui).length).toBe(1));
  choose(ui, id);
}

test("models across providers load once on opening; only a verified selection enables paid confirmation", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input) =>
      fetchUrl(input).includes("model=") ? choice(googleModel) : page([openaiModel, googleModel]),
    );
  const ui = mount(fetcher);
  await vi.waitFor(() => expect(choices(ui).length).toBe(2));
  expect(ui.confirm.disabled).toBe(true);
  const prompt = ui.dialog.querySelector("textarea")!;
  prompt.value = "private prompt survives metadata reads";
  prompt.focus();
  choose(ui, googleModel.id);
  await vi.waitFor(() => expect(ui.confirm.disabled).toBe(false));
  expect(ui.quote.value).toBe(googleModel.id);
  expect(document.activeElement).toBe(prompt);
  expect(prompt.value).toContain("survives");
  ui.dialog.dispatchEvent(new Event("artwork-model-options"));
  expect(fetcher).toHaveBeenCalledTimes(2);
  const provider = ui.region.querySelector<HTMLSelectElement>("[data-model-provider]")!;
  provider.value = "google";
  provider.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(ui.quote.value).toBe(googleModel.id));
  ui.region.querySelector<HTMLButtonElement>("[data-model-refresh]")!.click();
  await vi.waitFor(() => expect(ui.quote.value).toBe(googleModel.id));
  expect(provider.value).toBe("google");
  ui.region.hidden = true;
  ui.dialog.dispatchEvent(new Event("artwork-model-options"));
  expect(ui.confirm.disabled).toBe(false);
});

test.each([200, 503])(
  "late selection metadata (HTTP %i) cannot replace a newer provider choice",
  async (oldStatus) => {
    const old = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const id = new URL(fetchUrl(input), "http://localhost").searchParams.get("model");
      if (id === openaiModel.id) return old.promise;
      if (id) return choice(googleModel);
      return page([openaiModel, googleModel]);
    });
    const ui = mount(fetcher);
    await vi.waitFor(() => expect(choices(ui).length).toBe(2));
    choose(ui, openaiModel.id);
    choose(ui, googleModel.id);
    await vi.waitFor(() => expect(ui.quote.value).toBe(googleModel.id));
    old.resolve(
      oldStatus === 200
        ? choice(openaiModel)
        : new Response(JSON.stringify({ error: "old selection failed" }), { status: oldStatus }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await vi.waitFor(() => expect(ui.confirm.disabled).toBe(false));
    expect(ui.model.value).toBe(googleModel.id);
    expect(ui.quote.value).toBe(googleModel.id);
  },
);

test("search, refresh and pagination are metadata-only and keep source failures visible", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(fetchUrl(input), "http://localhost");
    if (url.searchParams.has("model")) return choice(googleModel);
    if (url.searchParams.has("cursor"))
      return page([googleModel, routerModel], null, ["fal catalog unavailable"]);
    return page([openaiModel, googleModel], "next-page");
  });
  const ui = mount(fetcher);
  await vi.waitFor(() => expect(choices(ui).length).toBe(2));
  ui.region.querySelector<HTMLButtonElement>("[data-model-more]")!.click();
  await vi.waitFor(() => expect(choices(ui).length).toBe(3));
  expect(ui.region.querySelector("[data-model-errors]")!.textContent).toContain("unavailable");
  const provider = ui.region.querySelector<HTMLSelectElement>("[data-model-provider]")!;
  provider.value = "google";
  provider.dispatchEvent(new Event("change"));
  expect(choices(ui).length).toBe(1);
  provider.value = "connected";
  provider.dispatchEvent(new Event("change"));
  expect(choices(ui).length).toBe(3);
  const enter = new document.defaultView!.KeyboardEvent("keydown", {
    key: "Enter",
    cancelable: true,
  });
  ui.search.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(true);
  ui.search.value = "new search";
  ui.search.dispatchEvent(new Event("input"));
  await vi.waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => fetchUrl(url).includes("q=new+search"))).toBe(true),
  );
  ui.region.querySelector<HTMLButtonElement>("[data-model-refresh]")!.click();
  await vi.waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => fetchUrl(url).includes("refresh=1"))).toBe(true),
  );
  expect(fetcher.mock.calls.every(([url]) => fetchUrl(url).startsWith("/image-models?"))).toBe(
    true,
  );
});

test("catalog or contract failures never enable confirmation, and photo-only dialogs do not query models", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify({ error: "catalog unavailable" }), { status: 503 }),
    );
  const ui = mount(fetcher);
  await vi.waitFor(() =>
    expect(ui.region.querySelector("[data-model-status]")!.textContent).toBe("catalog unavailable"),
  );
  expect(ui.confirm.disabled).toBe(true);
  const alone = document.createElement("dialog");
  bindImageModelPicker(alone, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("a model verification hidden by another image action is retried when artwork options reopen", async () => {
  const pending = deferred<Response>();
  let reads = 0;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (!fetchUrl(input).includes("model=")) return page([openaiModel]);
    reads++;
    return reads === 1 ? pending.promise : choice(openaiModel);
  });
  const ui = mount(fetcher);
  await chooseSingleEntry(ui, openaiModel.id);
  ui.region.hidden = true;
  ui.dialog.dispatchEvent(new Event("artwork-model-options"));
  pending.resolve(choice(openaiModel));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(ui.quote.value).toBe("");
  ui.region.hidden = false;
  ui.dialog.dispatchEvent(new Event("artwork-model-options"));
  await vi.waitFor(() => expect(ui.quote.value).toBe(openaiModel.id));
  expect(reads).toBe(2);
  expect(ui.confirm.disabled).toBe(false);
});

test("saved choices outside the first page are verified and restored without a hardcoded option", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input) =>
      fetchUrl(input).includes("model=") ? choice(openaiModel) : page([googleModel]),
    );
  const ui = mount(fetcher, openaiModel.id);
  await vi.waitFor(() => expect(ui.quote.value).toBe(openaiModel.id));
  expect(ui.model.value).toBe(openaiModel.id);
  ui.model.value = "";
  ui.model.dispatchEvent(new Event("change"));
  expect(ui.quote.value).toBe("");
  expect(ui.confirm.disabled).toBe(true);
  ui.dialog.dispatchEvent(new Event("artwork-model-options"));
  await vi.waitFor(() => expect(ui.quote.value).toBe(openaiModel.id));
  ui.model.value = "";
  delete ui.model.dataset["initialModel"];
  ui.model.dispatchEvent(new Event("change"));
  const reads = fetcher.mock.calls.length;
  ui.dialog.dispatchEvent(new Event("artwork-model-options"));
  expect(ui.confirm.disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(reads);
});

test("mismatched or unsupported contracts never produce a confirmed selection", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input) =>
      fetchUrl(input).includes("model=") ? choice(googleModel) : page([openaiModel]),
    );
  const ui = mount(fetcher);
  await chooseSingleEntry(ui, openaiModel.id);
  await vi.waitFor(() =>
    expect(ui.region.querySelector("[data-model-status]")!.textContent).toContain("일치하지"),
  );
  expect(ui.quote.value).toBe("");
  expect(ui.confirm.disabled).toBe(true);
});

test.each([200, 503])(
  "older catalog reads (HTTP %i) and detached dialogs cannot overwrite the current model list",
  async (oldStatus) => {
    const pending = deferred<Response>();
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      reads++;
      return reads === 1 ? pending.promise : page([googleModel]);
    });
    const ui = mount(fetcher);
    ui.region.querySelector<HTMLButtonElement>("[data-model-refresh]")!.click();
    await vi.waitFor(() =>
      expect(choices(ui).some((option) => option.value === googleModel.id)).toBe(true),
    );
    pending.resolve(
      oldStatus === 200
        ? page([openaiModel])
        : new Response(JSON.stringify({ error: "old catalog failed" }), { status: oldStatus }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(choices(ui).some((option) => option.value === openaiModel.id)).toBe(false);
    const detached = deferred<Response>();
    fetcher.mockReturnValueOnce(detached.promise);
    ui.region.querySelector<HTMLButtonElement>("[data-model-refresh]")!.click();
    ui.dialog.remove();
    detached.resolve(page([openaiModel]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(choices(ui).some((option) => option.value === openaiModel.id)).toBe(false);
  },
);

test("non-Error metadata failures stay safe and do not enable a paid confirmation", async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue("offline");
  const ui = mount(fetcher);
  await vi.waitFor(() =>
    expect(ui.region.querySelector("[data-model-status]")!.textContent).toContain(
      "카탈로그를 읽지 못",
    ),
  );
  const rejection = vi.fn<typeof fetch>().mockRejectedValue("untrusted failure");
  fetcher.mockImplementation(async (input) => {
    if (fetchUrl(input).includes("model=")) return rejection(input);
    return page([openaiModel]);
  });
  ui.region.querySelector<HTMLButtonElement>("[data-model-refresh]")!.click();
  await chooseSingleEntry(ui, openaiModel.id);
  await vi.waitFor(() =>
    expect(ui.region.querySelector("[data-model-status]")!.textContent).toBe(
      "모델 정보를 읽지 못했습니다.",
    ),
  );
  expect(ui.confirm.disabled).toBe(true);
  const key = new document.defaultView!.KeyboardEvent("keydown", { key: "x", cancelable: true });
  ui.search.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(false);
});

test("a disconnected saved model remains visible but cannot be confirmed", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (fetchUrl(input).includes("model="))
      return new Response(JSON.stringify({ error: "API key missing" }), { status: 400 });
    return Response.json({
      models: [
        { ...openaiModel, releaseDate: "2026-11-01", connected: false, reason: "API key missing" },
      ],
      errors: [],
      nextCursor: null,
    });
  });
  const ui = mount(fetcher, openaiModel.id);
  await vi.waitFor(() =>
    expect(ui.region.querySelector("[data-model-status]")!.textContent).toBe("API key missing"),
  );
  const provider = ui.region.querySelector<HTMLSelectElement>("[data-model-provider]")!;
  provider.value = "";
  provider.dispatchEvent(new Event("change"));
  expect(choices(ui)[0]!.disabled).toBe(true);
  expect(ui.quote.value).toBe("");
  expect(ui.confirm.disabled).toBe(true);
  provider.value = "connected";
  provider.dispatchEvent(new Event("change"));
  expect(choices(ui)).toHaveLength(0);
});

test("connected fal models are visible as distinct versioned rows with IDs, rather than a giant native dropdown", async () => {
  const lite = {
    ...seedreamModel,
    id: "fal:bytedance/seedream/v5/lite/edit",
    model: "bytedance/seedream/v5/lite/edit",
    name: "Seedream 5 · Lite",
  };
  const flash = {
    ...lite,
    id: "fal:bytedance/seedream/v5/flash/edit",
    model: "bytedance/seedream/v5/flash/edit",
    name: "Seedream 5 · Flash",
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (fetchUrl(input).includes("model=")) return choice(lite);
    return Response.json({
      models: [
        ...[lite, flash].map((model) => ({
          ...model,
          releaseDate: "",
          connected: true,
          reason: "",
        })),
        { ...openaiModel, releaseDate: "", connected: false, reason: "API key missing" },
      ],
      errors: [],
      nextCursor: null,
    });
  });
  const ui = mount(fetcher);
  await vi.waitFor(() => expect(choices(ui)).toHaveLength(2));
  expect(ui.region.querySelector('[name="rigArtworkModel"]')!.tagName).toBe("INPUT");
  expect(ui.region.querySelector<HTMLSelectElement>("[data-model-provider]")!.value).toBe("fal");
  expect(ui.region.querySelector("[data-model-list]")!.textContent).toContain("Seedream 5 · Lite");
  expect(ui.region.querySelector("[data-model-list]")!.textContent).toContain(
    "bytedance/seedream/v5/flash/edit",
  );
  choose(ui, lite.id);
  await vi.waitFor(() => expect(ui.quote.value).toBe(lite.id));
  expect(choices(ui).find((radio) => radio.value === lite.id)!.checked).toBe(true);
  expect(ui.confirm.disabled).toBe(false);
});

test("a provider removed by refresh cannot leave a stale filter or confirmed selection", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(page([openaiModel, googleModel]))
    .mockImplementation(async () => page([openaiModel]));
  const ui = mount(fetcher);
  await vi.waitFor(() => expect(choices(ui)).toHaveLength(2));
  const provider = ui.region.querySelector<HTMLSelectElement>("[data-model-provider]")!;
  provider.value = "google";
  provider.dispatchEvent(new Event("change"));
  ui.region.querySelector<HTMLButtonElement>("[data-model-refresh]")!.click();
  await vi.waitFor(() => expect(provider.value).toBe(""));
  ui.region.querySelector("[data-model-list]")!.dispatchEvent(new Event("change"));
  expect(choices(ui)).toHaveLength(1);
  expect(ui.quote.value).toBe("");
  expect(ui.confirm.disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
