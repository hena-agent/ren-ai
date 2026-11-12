import { expect, test, vi } from "vitest";
import { useBrowser } from "../test/browser.ts";
import { fixture, legacy, portraitImage, request } from "../test/fixtures.ts";
import { bindRigTest } from "./rig-test-browser.ts";
import { deferred } from "../test/queue.ts";
import { storedLayers } from "../test/artwork-layers.ts";
import { faceRoles } from "./rig-face.ts";

useBrowser();
type RigTestRuntime = Awaited<ReturnType<Parameters<typeof bindRigTest>[1]>>;

async function mounted(
  complete = false,
  readable = true,
  outfit = false,
  sourcePivots = false,
  facial = false,
) {
  const { admin, store } = await fixture();
  await store.create(legacy);
  const imageUrl = await store.saveImage(portraitImage);
  await store.saveRigArtwork(legacy.id, {
    model: "fal:test",
    imageUrl,
    operationId: "test-operation",
    kind: "body",
  });
  const layers = storedLayers(imageUrl, "test-operation");
  await store.saveRigArtworkLayers(legacy.id, {
    ...layers,
    ...(facial && {
      faceParts: faceRoles.map(([role]) => ({ role, state: "neutral" as const, imageUrl })),
    }),
    ...(sourcePivots && { jointPositions: [{ name: "forearm_l", x: 0.364, y: 0.356 }] }),
    layers: layers.layers.map((layer) => ({
      ...layer,
      name: layer.zIndex === 0 ? "Base" : "Forearm",
      bone: layer.zIndex === 0 ? "root" : "forearm_l",
      ...(facial && layer.zIndex === 1 && { plane: "face" as const }),
    })),
  });
  if (outfit) {
    await store.saveRigArtworkOutfit(legacy.id, {
      model: "fal:outfit",
      imageUrl,
      operationId: "outfit",
      sourceOperationId: "test-operation",
      layers: {
        ...storedLayers(imageUrl, "outfit"),
        layers: storedLayers(imageUrl, "outfit").layers.map((layer) => ({
          ...layer,
          name: layer.zIndex === 0 ? "Base" : "Forearm sleeve",
        })),
      },
    });
  }
  document.body.innerHTML = await (await admin(request(`/personas/${legacy.id}/rig-test`))).text();
  const page = document.querySelector<HTMLElement>("[data-rig-test]")!;
  const image = page.querySelector<HTMLImageElement>("[data-rig-source]")!;
  vi.spyOn(image, "complete", "get").mockReturnValue(complete);
  vi.spyOn(image, "naturalWidth", "get").mockReturnValue(readable ? 640 : 0);
  vi.spyOn(image, "naturalHeight", "get").mockReturnValue(960);
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const errors = vi.fn<(error: Error) => void>();
  window.reportError = errors;
  let resize: () => void = vi.fn<() => void>();
  class Observer implements ResizeObserver {
    observe = vi.fn<ResizeObserver["observe"]>();
    unobserve = vi.fn<ResizeObserver["unobserve"]>();
    disconnect = vi.fn<ResizeObserver["disconnect"]>();
    constructor(callback: ResizeObserverCallback) {
      resize = () => callback([], this);
    }
  }
  window.ResizeObserver = Observer;
  const runtime: RigTestRuntime = {
    player: {
      play: vi.fn<RigTestRuntime["player"]["play"]>(),
      frame: vi.fn<RigTestRuntime["player"]["frame"]>(),
      setAlpha: vi.fn<RigTestRuntime["player"]["setAlpha"]>(),
      slots: null,
      adjust: null,
      repose: vi.fn<RigTestRuntime["player"]["repose"]>(),
    },
    syncPixelRatio: vi.fn<() => void>(),
    dispose: vi.fn<() => void>(),
  };
  const create = vi.fn<Parameters<typeof bindRigTest>[1]>().mockResolvedValue(runtime);
  const button = (key: string) => page.querySelector<HTMLButtonElement>(`[data-rig-${key}]`)!;
  return {
    page,
    image,
    imageUrl,
    frames,
    errors,
    runtime,
    create,
    button,
    resize: () => resize(),
    start: () => bindRigTest(page, create),
  };
}

test("body/outfit filters and per-part visibility exclude background ghosts and clear empty renders", async () => {
  const ui = await mounted(true, true, true);
  const dispose = ui.start();
  await vi.waitFor(() => expect(ui.create).toHaveBeenCalledOnce());
  expect(ui.create.mock.calls[0]![1].pages.map((part) => part.name)).toEqual([
    "body-1",
    "outfit-1",
  ]);
  const view = ui.page.querySelector<HTMLSelectElement>("[data-rig-view]")!;
  view.value = "body";
  view.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(ui.create).toHaveBeenCalledTimes(2));
  expect(ui.create.mock.calls[1]![1].pages.map((part) => part.name)).toEqual(["body-1"]);
  view.value = "outfit";
  view.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(ui.create).toHaveBeenCalledTimes(3));
  expect(ui.create.mock.calls[2]![1].pages.map((part) => part.name)).toEqual(["outfit-1"]);
  const toggle = ui.page.querySelector<HTMLInputElement>(
    '[data-rig-group="outfit"][data-z-index="1"] [data-rig-layer-enabled]',
  )!;
  toggle.checked = false;
  toggle.dispatchEvent(new Event("change"));
  expect(ui.page.dataset["rigState"]).toBe("empty");
  expect(ui.button("restart").disabled).toBe(true);
  expect(ui.page.querySelector("[data-rig-player]")!.children).toHaveLength(0);
  toggle.checked = true;
  toggle.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(ui.page.dataset["rigState"]).toBe("playing"));
  expect(ui.errors).not.toHaveBeenCalled();
  dispose();
});

test("source-specific pivots are loaded from the saved layer result and reset restores those pivots", async () => {
  const ui = await mounted(true, true, false, true);
  const dispose = ui.start();
  await vi.waitFor(() => expect(ui.page.dataset["rigState"]).toBe("playing"));
  const elbow = ui.page.querySelectorAll<HTMLButtonElement>("[data-rig-joints] button")[4]!;
  expect(elbow.style.left).toBe("36.4%");
  elbow.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight" }));
  expect(elbow.style.left).not.toBe("36.4%");
  ui.button("reset").click();
  expect(elbow.style.left).toBe("36.4%");
  expect(elbow.style.top).toBe("35.6%");
  dispose();
});

test("A/B/C/D comparisons hold one camera, isolate body assets and freeze the rest rig without a second resampling canvas", async () => {
  const ui = await mounted(true, true, true, false, true);
  const dispose = ui.start();
  await vi.waitFor(() => expect(ui.create).toHaveBeenCalledOnce());
  const mode = ui.page.querySelector<HTMLSelectElement>("[data-rig-comparison]")!;
  const change = (value: string) => {
    mode.value = value;
    mode.dispatchEvent(new Event("change"));
  };
  const transform = () =>
    ui.page.querySelector<HTMLElement>(".rig-test-render-root")!.style.transform;
  const camera = transform();
  const backdrop = ui.page.querySelector<HTMLSelectElement>("[data-rig-backdrop]")!;
  backdrop.value = "#657077";
  backdrop.dispatchEvent(new Event("change"));
  expect(ui.page.querySelector<HTMLElement>("[data-rig-stage]")!.style.backgroundColor).toBe(
    "#657077",
  );
  change("original");
  expect(ui.page.dataset["rigState"]).toBe("static");
  expect(transform()).toBe(camera);
  expect(ui.page.querySelectorAll("[data-rig-player] img")).toHaveLength(1);
  change("flat");
  expect(ui.page.querySelectorAll("[data-rig-player] img")).toHaveLength(1);
  expect(transform()).toBe(camera);
  expect(ui.create).toHaveBeenCalledOnce();
  change("rig");
  await vi.waitFor(() => expect(ui.create).toHaveBeenCalledTimes(2));
  expect(ui.page.dataset["rigState"]).toBe("paused");
  expect(transform()).toBe(camera);
  expect(ui.create.mock.calls[1]![1].pages.map((page) => page.name)).toEqual(["body-1"]);
  expect(ui.page.querySelector<HTMLSelectElement>("[data-rig-motion]")!.disabled).toBe(true);
  const count = vi.mocked(ui.runtime.player.frame).mock.calls.length;
  ui.frames.shift()!(1000);
  expect(ui.runtime.player.frame).toHaveBeenCalledTimes(count);
  change("motion");
  await vi.waitFor(() => expect(ui.create).toHaveBeenCalledTimes(3));
  expect(ui.page.querySelector<HTMLFieldSetElement>("[data-rig-face-controls]")!.disabled).toBe(
    true,
  );
  change("live");
  await vi.waitFor(() => expect(ui.create).toHaveBeenCalledTimes(4));
  expect(ui.page.querySelector<HTMLFieldSetElement>("[data-rig-face-controls]")!.disabled).toBe(
    false,
  );
  for (const input of ui.page.querySelectorAll<HTMLInputElement>("[data-rig-layer-enabled]"))
    input.checked = false;
  change("original");
  expect(ui.page.dataset["rigState"]).toBe("static");
  dispose();
});

test("comparison image failures are correlated and an obsolete comparison cannot fail a newer view", async () => {
  const ui = await mounted(true);
  const dispose = ui.start();
  await vi.waitFor(() => expect(ui.page.dataset["rigState"]).toBe("playing"));
  const mode = ui.page.querySelector<HTMLSelectElement>("[data-rig-comparison]")!;
  mode.value = "original";
  mode.dispatchEvent(new Event("change"));
  const old = ui.page.querySelector("[data-rig-player] img")!;
  mode.value = "flat";
  mode.dispatchEvent(new Event("change"));
  old.dispatchEvent(new Event("error"));
  expect(ui.errors).not.toHaveBeenCalled();
  ui.page.querySelector("[data-rig-player] img")!.dispatchEvent(new Event("error"));
  expect(ui.page.dataset["rigState"]).toBe("failed");
  expect(ui.errors).toHaveBeenCalledOnce();
  dispose();
});

test("complete face parts replace the original face, retain their own head rig, and are excluded from outfit-only rendering", async () => {
  const ui = await mounted(true, true, true, false, true);
  const dispose = ui.start();
  await vi.waitFor(() => expect(ui.page.dataset["rigState"]).toBe("playing"));
  const model = ui.create.mock.calls[0]![1];
  expect(model.slots.map((slot) => slot.name)).not.toContain("body-1");
  expect(model.slots.map((slot) => slot.name)).toContain("face-base-neutral");
  expect(model.bones.slice(-2).map((bone) => bone.name)).toEqual(["pupil-left", "pupil-right"]);
  const framing = ui.page.querySelector<HTMLSelectElement>("[data-rig-framing]")!;
  framing.value = "full";
  framing.dispatchEvent(new Event("change"));
  const view = ui.page.querySelector<HTMLSelectElement>("[data-rig-view]")!;
  view.value = "outfit";
  view.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(ui.create).toHaveBeenCalledTimes(2));
  expect(ui.create.mock.calls[1]![1].slots.map((slot) => slot.name)).toEqual(["outfit-1"]);
  expect(ui.errors).not.toHaveBeenCalled();
  dispose();
});

test("source load starts the rig; controls, hidden tabs and teardown drive the real player interface", async () => {
  const ui = await mounted();
  const dispose = ui.start();
  ui.resize();
  const motion = ui.page.querySelector<HTMLSelectElement>("[data-rig-motion]")!;
  const strength = ui.page.querySelector<HTMLInputElement>("[data-rig-strength]")!;
  motion.dispatchEvent(new Event("change"));
  strength.dispatchEvent(new Event("input"));
  ui.button("rest").dispatchEvent(new Event("click"));
  ui.frames.shift()!(16);
  expect(ui.runtime.player.frame).not.toHaveBeenCalled();
  ui.image.dispatchEvent(new Event("load"));
  await vi.waitFor(() => expect(ui.page.dataset["rigState"]).toBe("playing"));
  expect(ui.create.mock.calls[0]![1].bones).toHaveLength(16);
  expect(ui.create.mock.calls[0]![2].get("body-1")).toBe(ui.imageUrl);
  motion.value = "elbows";
  motion.dispatchEvent(new Event("change"));
  strength.value = "0.8";
  strength.dispatchEvent(new Event("input"));
  expect(ui.runtime.player.setAlpha).toHaveBeenCalledWith(0, 0.8);
  expect(ui.runtime.player.play).toHaveBeenLastCalledWith("elbows", {
    loop: true,
    alpha: 0.75,
    mix: 0.15,
  });
  ui.frames.shift()!(1016);
  expect(ui.runtime.player.frame).toHaveBeenLastCalledWith(0.05);
  ui.button("pause").click();
  expect(ui.page.dataset["rigState"]).toBe("paused");
  const count = vi.mocked(ui.runtime.player.frame).mock.calls.length;
  ui.frames.shift()!(1032);
  expect(ui.runtime.player.frame).toHaveBeenCalledTimes(count);
  ui.button("pause").click();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  ui.frames.shift()!(1048);
  expect(ui.runtime.player.frame).toHaveBeenCalledTimes(count);
  hidden.mockReturnValue(false);
  ui.button("restart").click();
  expect(ui.runtime.player.frame).toHaveBeenLastCalledWith(0);
  ui.button("reset").click();
  await vi.waitFor(() => expect(ui.create).toHaveBeenCalledTimes(2));
  expect(ui.runtime.dispose).toHaveBeenCalledOnce();
  const cached = new document.defaultView!.PageTransitionEvent("pagehide");
  Object.defineProperty(cached, "persisted", { value: true });
  window.dispatchEvent(cached);
  expect(ui.runtime.dispose).toHaveBeenCalledOnce();
  window.dispatchEvent(
    new document.defaultView!.PageTransitionEvent("pagehide", { persisted: false }),
  );
  expect(ui.runtime.dispose).toHaveBeenCalledTimes(2);
  ui.frames.shift()!(1064);
  dispose();
});

test("fixed rest/bent poses step layered tracks without unsupported seeking and bindings can be changed", async () => {
  const ui = await mounted(true);
  const dispose = ui.start();
  await vi.waitFor(() => expect(ui.page.dataset["rigState"]).toBe("playing"));
  ui.button("bent").click();
  expect(ui.runtime.player.frame).toHaveBeenLastCalledWith(1);
  expect(ui.page.dataset["rigState"]).toBe("paused");
  ui.button("rest").click();
  expect(ui.runtime.player.play).toHaveBeenLastCalledWith("rest", { loop: true, alpha: 0.75 });
  expect(ui.runtime.player.frame).toHaveBeenLastCalledWith(0);
  ui.button("head-left").click();
  expect(ui.runtime.player.play).toHaveBeenLastCalledWith("nod", { loop: true, alpha: 0.75 });
  expect(ui.runtime.player.frame).toHaveBeenLastCalledWith(1);
  ui.button("head-right").click();
  expect(ui.runtime.player.frame).toHaveBeenLastCalledWith(3);
  const select = ui.page.querySelectorAll<HTMLSelectElement>("[data-rig-layer-bone]")[1]!;
  select.value = "head";
  select.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(ui.create).toHaveBeenCalledTimes(2));
  expect(
    ui.create.mock.calls[1]![1].skins[0]!.attachments["body-1"]!["body-1"]!.vertices
      .bindings[0]![0]!.bone,
  ).toBe("head");
  dispose();
});

test("unclassified connections identify the layer and can be corrected without generating images", async () => {
  const ui = await mounted(true);
  const select = ui.page.querySelectorAll<HTMLSelectElement>("[data-rig-layer-bone]")[1]!;
  select.value = "";
  const dispose = ui.start();
  await vi.waitFor(() => expect(ui.errors).toHaveBeenCalledOnce());
  expect(ui.page.querySelector("[data-rig-status]")!.textContent).toContain("관절 연결");
  select.value = "forearm_l";
  select.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(ui.page.dataset["rigState"]).toBe("playing"));
  dispose();
});

test.each(["image-error", "unreadable", "runtime-error", "runtime-string"])(
  "preview failures (%s) retain safe correlated diagnostics and do not call generation",
  async (failure) => {
    const ui = await mounted(failure === "unreadable", failure !== "unreadable");
    if (failure === "runtime-error")
      ui.create.mockRejectedValue(new Error("private image bytes and prompt"));
    if (failure === "runtime-string") ui.create.mockRejectedValue("private text");
    const dispose = ui.start();
    if (failure === "image-error") ui.image.dispatchEvent(new Event("error"));
    if (failure.startsWith("runtime")) ui.image.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(ui.errors).toHaveBeenCalledOnce());
    expect(ui.page.dataset["rigState"]).toBe("failed");
    expect(ui.button("pause").disabled).toBe(true);
    const cause = vi.mocked(ui.errors).mock.calls[0]![0];
    expect(cause).toMatchObject({
      cause: { code: "rig_preview_failed", requestId: ui.page.dataset["requestId"] },
    });
    expect(JSON.stringify(cause)).not.toMatch(/private image|private text/);
    dispose();
  },
);

test.each(["resolve", "reject"])(
  "an obsolete rig creation (%s) cannot replace a newer joint edit",
  async (outcome) => {
    const ui = await mounted(true);
    const pending = deferred<RigTestRuntime>();
    ui.create.mockReturnValueOnce(
      pending.promise.then((value) => {
        if (outcome === "reject") throw new Error("old failure");
        return value;
      }),
    );
    const dispose = ui.start();
    await vi.waitFor(() => expect(ui.create).toHaveBeenCalledOnce());
    const marker = ui.page.querySelector<HTMLButtonElement>("[data-rig-joints] button")!;
    marker.dispatchEvent(new document.defaultView!.KeyboardEvent("keydown", { key: "ArrowRight" }));
    await vi.waitFor(() => expect(ui.page.dataset["rigState"]).toBe("playing"));
    const old = { ...ui.runtime, dispose: vi.fn<() => void>() };
    pending.resolve(old);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ui.errors).not.toHaveBeenCalled();
    expect(old.dispose).toHaveBeenCalledTimes(outcome === "resolve" ? 1 : 0);
    expect(ui.create).toHaveBeenCalledTimes(2);
    dispose();
  },
);

test("leaving before model preparation finishes never creates a player", async () => {
  const ui = await mounted(true);
  const dispose = ui.start();
  dispose();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(ui.create).not.toHaveBeenCalled();
});

const pointer = (type: string, x = 0, y = 0) =>
  new document.defaultView!.PointerEvent(type, {
    bubbles: true,
    pointerId: 1,
    clientX: x,
    clientY: y,
  });

test("pointer and keyboard joint edits are clamped, rebind the mesh on release, and reset independently", async () => {
  const ui = await mounted(true);
  const dispose = ui.start();
  await vi.waitFor(() => expect(ui.page.dataset["rigState"]).toBe("playing"));
  const area = ui.page.querySelector<HTMLElement>("[data-rig-source-area]")!;
  vi.spyOn(area, "getBoundingClientRect").mockReturnValue(
    new document.defaultView!.DOMRect(0, 0, 300, 450),
  );
  const marker = area.querySelector<HTMLButtonElement>("button")!;
  marker.setPointerCapture = vi.fn<(id: number) => void>();
  area.dispatchEvent(pointer("pointermove", 50, 50));
  area.dispatchEvent(pointer("pointerup"));
  marker.dispatchEvent(new document.defaultView!.KeyboardEvent("keydown", { key: "a" }));
  expect(ui.create).toHaveBeenCalledOnce();
  marker.dispatchEvent(pointer("pointerdown"));
  area.dispatchEvent(pointer("pointermove", -40, 500));
  expect(marker.style.left).toBe("0%");
  expect(marker.style.top).toBe("100%");
  area.dispatchEvent(pointer("pointercancel"));
  await vi.waitFor(() => expect(ui.create).toHaveBeenCalledTimes(2));
  marker.dispatchEvent(
    new document.defaultView!.KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true }),
  );
  expect(marker.style.left).toBe("2%");
  await vi.waitFor(() => expect(ui.create).toHaveBeenCalledTimes(3));
  ui.button("reset").click();
  await vi.waitFor(() => expect(marker.style.left).toBe("50%"));
  dispose();
});
