import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { useBrowser } from "../test/browser.ts";
import { layerService, storedLayers } from "../test/artwork-layers.ts";
import { fixture, legacy, portraitImage, request } from "../test/fixtures.ts";
import { ImageOptions } from "./image-options.tsx";
import { bindPortraitDialog } from "./portrait-dialog.ts";
import { bindArtworkLayerDialog } from "./artwork-layer-dialog.ts";
import { bindArtworkLayerViewer } from "./artwork-layer-viewer.ts";
import { deferred } from "../test/queue.ts";
import { fetchUrl } from "../test/fetch-url.ts";

useBrowser();

function mounted(fetcher: typeof fetch, retry?: "cached" | "uncertain") {
  vi.stubGlobal("fetch", fetcher);
  document.body.innerHTML = renderToStaticMarkup(
    <form>
      <input name="name" defaultValue="하린" />
      <a href="/images/source.png" data-artwork-original>
        원본
      </a>
      <ImageOptions />
      <button
        type="submit"
        name="intent"
        value="rig-layers"
        data-portrait-operation="layers:source"
        data-portrait-style="anime"
        data-layerize-target="true"
        data-layerize-persona="harin"
        data-layerize-source="art-source"
        data-layerize-retry={retry ? "true" : undefined}
        data-layerize-cached={retry === "cached" ? "true" : undefined}
        data-layerize-price="USD 0.03375 / 레이어"
      >
        분리
      </button>
      <button type="submit" name="intent" value="generate" data-portrait-style="photo">
        사진
      </button>
    </form>,
  );
  const form = document.querySelector("form")!;
  const dialog = form.querySelector<HTMLDialogElement>("dialog")!;
  const confirm = dialog.querySelector<HTMLButtonElement>("[data-portrait-confirm]")!;
  const prompt = dialog.querySelector("textarea")!;
  const submissions: FormData[] = [];
  bindPortraitDialog(form);
  form.addEventListener("submit", (event) => {
    if (!event.defaultPrevented) {
      submissions.push(new FormData(form));
      event.preventDefault();
    }
  });
  const open = () =>
    form.requestSubmit(form.querySelector<HTMLButtonElement>('[value="rig-layers"]'));
  open();
  return { form, dialog, confirm, prompt, submissions, open };
}

test("layer separation confirms the actual source, per-layer price and optional prompt; cancellation is free", async () => {
  const { service } = layerService();
  const options = await service.options("art-source");
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(options));
  const ui = mounted(fetcher);
  expect(ui.confirm.disabled).toBe(true);
  expect(ui.dialog.querySelector("h2")!.textContent).toBe("원화 레이어 분리");
  expect(ui.dialog.querySelector("[data-portrait-target] img")!.getAttribute("alt")).toContain(
    "분리할 원본",
  );
  await vi.waitFor(() => expect(ui.confirm.disabled).toBe(false));
  ui.prompt.value = "separate both hands";
  ui.dialog.querySelector<HTMLButtonElement>("[data-portrait-cancel]")!.click();
  expect(ui.submissions).toHaveLength(0);
  ui.open();
  expect(ui.prompt.value).toBe("separate both hands");
  await vi.waitFor(() => expect(ui.confirm.disabled).toBe(false));
  ui.confirm.click();
  expect(ui.submissions).toHaveLength(1);
  expect(ui.submissions[0]!.get("layerizeQuote")).toBe(options.quote);
  expect(ui.submissions[0]!.get("portraitInstructions")).toBe("separate both hands");
  expect(ui.submissions[0]!.get("imageCount")).toBe("1");
  expect(ui.submissions[0]!.get("rigArtworkModel")).toBeNull();
  expect(
    fetcher.mock.calls.every(
      ([url, init]) => fetchUrl(url).startsWith("/artwork-layer-options?") && !init?.method,
    ),
  ).toBe(true);
});

test.each(["http", "non-error", "wrong-source"])(
  "metadata failure %s never enables paid confirmation",
  async (failure) => {
    const { service } = layerService();
    const options = await service.options("wrong-source");
    const fetcher = vi.fn<typeof fetch>();
    if (failure === "http")
      fetcher.mockResolvedValue(Response.json({ error: "not ready" }, { status: 503 }));
    else if (failure === "non-error") fetcher.mockRejectedValue("offline");
    else fetcher.mockResolvedValue(Response.json(options));
    const ui = mounted(fetcher);
    await vi.waitFor(() =>
      expect(ui.dialog.querySelector("[data-layerize-status]")!.textContent).not.toContain(
        "확인하고 있습니다",
      ),
    );
    expect(ui.confirm.disabled).toBe(true);
    expect(ui.dialog.querySelector<HTMLInputElement>('[name="layerizeQuote"]')!.value).toBe("");
  },
);

test.each([200, 503])(
  "late layer metadata (HTTP %i) cannot block another image action",
  async (status) => {
    const { service } = layerService();
    const options = await service.options("art-source");
    const pending = deferred<Response>();
    const ui = mounted(vi.fn<typeof fetch>().mockReturnValue(pending.promise));
    ui.dialog.querySelector<HTMLButtonElement>("[data-portrait-cancel]")!.click();
    ui.form.requestSubmit(ui.form.querySelector<HTMLButtonElement>('[value="generate"]'));
    pending.resolve(
      status === 200 ? Response.json(options) : Response.json({ error: "old failure" }, { status }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ui.confirm.disabled).toBe(false);
    expect(ui.dialog.querySelector<HTMLElement>("[data-layerize-options]")!.hidden).toBe(true);
    expect(ui.dialog.querySelector<HTMLInputElement>('[name="layerizeQuote"]')!.value).toBe("");
  },
);

test.each(["cached", "uncertain"] as const)(
  "retry %s retains the confirmed price and only cached output locks its prompt",
  (retry) => {
    const fetcher = vi.fn<typeof fetch>();
    const ui = mounted(fetcher, retry);
    expect(ui.confirm.disabled).toBe(false);
    expect(ui.prompt.readOnly).toBe(retry === "cached");
    expect(ui.dialog.querySelector("[data-layerize-price]")!.textContent).toContain("0.03375");
    expect(fetcher).not.toHaveBeenCalled();
    bindArtworkLayerDialog(document.createElement("dialog"), fetcher);
  },
);

test("the authenticated layer viewer can isolate outputs, compare the original and export placement without provider URLs", async () => {
  const { admin, store } = await fixture();
  await store.create(legacy);
  const imageUrl = await store.saveImage(portraitImage);
  await store.saveRigArtwork(legacy.id, {
    model: "fal:source",
    imageUrl,
    operationId: "art-source",
  });
  const path = `/personas/${legacy.id}/artwork-layers`;
  expect((await admin(request(path))).status).toBe(404);
  await store.saveRigArtworkLayers(legacy.id, { ...storedLayers(imageUrl), sourceRepair: true });
  const response = await admin(request(path));
  expect(response.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
  document.body.innerHTML = await response.text();
  expect(document.body.textContent).toContain("원본 기반 수작업 보정 적용");
  const canvas = document.querySelector<SVGSVGElement>("svg.layer-canvas")!;
  expect(canvas.getAttribute("viewBox")).toBe("0 0 1 1");
  expect(canvas.getAttribute("width")).toBe("1");
  expect(canvas.getAttribute("height")).toBe("1");
  expect(canvas.querySelectorAll("[style]")).toHaveLength(0);
  expect(canvas.hasAttribute("style")).toBe(false);
  expect(canvas.querySelector("[data-layer-image]")!.getAttribute("width")).toBe("1");
  bindArtworkLayerViewer(document);
  const toggles = [...document.querySelectorAll<HTMLInputElement>("[data-layer-toggle]")];
  toggles[0]!.click();
  expect(
    document
      .querySelector<SVGImageElement>(`[data-layer-image="${toggles[0]!.dataset["layerToggle"]}"]`)!
      .getAttribute("display"),
  ).toBe("none");
  document.querySelector<HTMLButtonElement>("[data-layers-none]")!.click();
  expect(document.querySelector("[data-layer-count]")!.textContent).toBe("0 / 2개 표시");
  document.querySelector<HTMLButtonElement>("[data-layers-all]")!.click();
  expect(toggles.every((toggle) => toggle.checked)).toBe(true);
  document.querySelector<HTMLInputElement>("[data-layer-compare]")!.click();
  const original = document.querySelector<SVGImageElement>("[data-layer-original]")!;
  expect(original.getAttribute("display")).toBe("inline");
  const opacity = document.querySelector<HTMLInputElement>("[data-layer-opacity]")!;
  opacity.value = "0.7";
  opacity.dispatchEvent(new Event("input"));
  expect(original.getAttribute("opacity")).toBe("0.7");
  document.querySelector<HTMLInputElement>("[data-layer-compare]")!.click();
  expect(original.getAttribute("display")).toBe("none");
  document.querySelector<HTMLButtonElement>('[data-layer-solo="1"]')!.click();
  expect(document.querySelector("[data-layer-count]")!.textContent).toBe("1 / 2개 표시");
  const x = document.querySelector<HTMLInputElement>('[data-layer-layout-field="x"]')!;
  x.value = "0.1";
  x.dispatchEvent(new Event("input"));
  expect(document.querySelector('[data-layer-image="1"]')!.getAttribute("x")).toBe("0.1");
  document
    .querySelector<HTMLSelectElement>("[data-layer-layout-select]")!
    .dispatchEvent(new Event("change"));
  document.querySelector<HTMLButtonElement>('[data-layer-solo="0"]')!.click();
  expect(document.querySelector("[data-layer-count]")!.textContent).toBe("1 / 2개 표시");
  expect((await admin(new Request(`http://localhost${path}`))).status).toBe(401);
  expect((await admin(request(path, { intent: "save" }))).status).toBe(405);
  expect((await admin(request("/other/artwork-layers"))).status).toBe(404);
  document.body.replaceChildren();
  bindArtworkLayerViewer(document);
});
