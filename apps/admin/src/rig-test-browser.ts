import type { RigPlayer, CanvasViewport } from "@rig-c/play";
import { createRigTestModel, type RigLayerBinding } from "./rig-test-model.ts";
import { bindRigJoints } from "./rig-test-joints.ts";
import { Schema } from "effect";
import { RigArtworkLayer, RigFacePart } from "@ren-ai/personas/rig-artwork";
import { faceSlot, composeFaceBindings, missingFaceParts } from "./rig-face.ts";
import { bindRigFace } from "./rig-face-browser.ts";
import { fitRigFrame, upperBodyFrame, rigViewport } from "./rig-test-framing.ts";
import { comparisonRoot } from "./rig-test-comparison.ts";

interface RigTestRuntime {
  player: Pick<RigPlayer, "play" | "frame" | "setAlpha" | "slots" | "adjust" | "repose">;
  syncPixelRatio: (viewport: CanvasViewport) => void;
  dispose: () => void;
}
type RuntimeFactory = (
  root: HTMLElement,
  model: Awaited<ReturnType<typeof createRigTestModel>>,
  images: ReadonlyMap<string, string>,
  viewport: CanvasViewport,
) => Promise<RigTestRuntime>;

export function bindRigTest(page: HTMLElement, createRuntime: RuntimeFactory) {
  const document = page.ownerDocument,
    window = document.defaultView!;
  const image = page.querySelector<HTMLImageElement>("[data-rig-source]")!;
  const stage = page.querySelector<HTMLElement>("[data-rig-stage]")!;
  const host = page.querySelector<HTMLElement>("[data-rig-player]")!;
  const status = page.querySelector<HTMLElement>("[data-rig-status]")!;
  const motion = page.querySelector<HTMLSelectElement>("[data-rig-motion]")!;
  const strength = page.querySelector<HTMLInputElement>("[data-rig-strength]")!;
  const pause = page.querySelector<HTMLButtonElement>("[data-rig-pause]")!;
  const restart = page.querySelector<HTMLButtonElement>("[data-rig-restart]")!;
  const reset = page.querySelector<HTMLButtonElement>("[data-rig-reset]")!;
  const rest = page.querySelector<HTMLButtonElement>("[data-rig-rest]")!;
  const bent = page.querySelector<HTMLButtonElement>("[data-rig-bent]")!;
  const headLeft = page.querySelector<HTMLButtonElement>("[data-rig-head-left]")!;
  const headRight = page.querySelector<HTMLButtonElement>("[data-rig-head-right]")!;
  const view = page.querySelector<HTMLSelectElement>("[data-rig-view]")!;
  const comparison = page.querySelector<HTMLSelectElement>("[data-rig-comparison]")!;
  const framing = page.querySelector<HTMLSelectElement>("[data-rig-framing]")!;
  const faceFields = page.querySelector<HTMLFieldSetElement>("[data-rig-face-controls]")!;
  const motionFields = [motion, strength, pause, restart, rest, bent, headLeft, headRight];
  const enableMotion = (enabled: boolean) => {
    for (const control of motionFields) control.disabled = !enabled;
  };
  const width = Number(page.dataset["rigWidth"]),
    height = Number(page.dataset["rigHeight"]);
  const faceParts = Schema.decodeUnknownSync(Schema.Array(RigFacePart))(
    JSON.parse(page.dataset["faceParts"]!),
  );
  const faceReady = missingFaceParts(faceParts).length === 0;
  const layers = [...page.querySelectorAll<HTMLElement>("[data-rig-layer]")].map((node) => ({
    node,
    layer: Schema.decodeUnknownSync(RigArtworkLayer)({
      name: node.dataset["layerName"],
      zIndex: Number(node.dataset["zIndex"]),
      imageUrl: node.dataset["imageUrl"],
      width: Number(node.dataset["imageWidth"]),
      height: Number(node.dataset["imageHeight"]),
      bounds: ["left", "top", "right", "bottom"].map((key) => Number(node.dataset[key])),
      plane: node.dataset["layerPlane"],
      ...(node.dataset["layerBone"] && { bone: node.dataset["layerBone"] }),
    }),
  }));
  const textures = new Map(
    layers.map(({ layer, node }) => [node.dataset["rigTexture"]!, layer.imageUrl]),
  );
  for (const part of faceParts) textures.set(faceSlot(part), part.imageUrl);
  let face: ReturnType<typeof bindRigFace> | undefined;
  let runtime: RigTestRuntime | undefined;
  let modelRoot: HTMLElement | undefined;
  let paused = false,
    disposed = false,
    revision = 0,
    frame = 0,
    last = 0;
  const obsolete = (observed: number) => disposed || observed !== revision;
  const release = () => {
    face?.dispose();
    face = undefined;
    runtime?.dispose();
    runtime = undefined;
  };
  const report = () => {
    const held = paused || comparison.value === "rig";
    page.dataset["rigState"] = held ? "paused" : "playing";
    status.textContent = `${held ? "일시정지" : "rig-c 재생 중"} · ${comparison.value === "live" ? motion.selectedOptions[0]!.textContent : comparison.selectedOptions[0]!.textContent} · 강도 ${Math.round(Number(strength.value) * 100)}%`;
  };
  const fit = () => {
    if (!modelRoot) return;
    const bounds = framing.value === "full" ? ([0, 0, width, height] as const) : portrait;
    stage.style.aspectRatio = `${bounds[2] - bounds[0]} / ${bounds[3] - bounds[1]}`;
    const fitted = fitRigFrame(bounds, width, height, stage.clientWidth, stage.clientHeight);
    modelRoot.style.left = `${fitted.left}px`;
    modelRoot.style.top = `${fitted.top}px`;
    modelRoot.style.transform = `scale(${fitted.scale})`;
    runtime?.syncPixelRatio(rigViewport(fitted, stage.clientWidth, stage.clientHeight));
    runtime?.player.frame(0);
  };
  const fail = (cause: Error | Event) => {
    page.dataset["rigState"] = "failed";
    status.textContent =
      "원화 또는 rig-c 재생기를 불러오지 못했습니다. 페이지를 새로고침해 주세요.";
    window.reportError(
      new Error("rig-c preview failed", {
        cause: {
          event: "rig.test.failed",
          stage: "preview.load",
          code: "rig_preview_failed",
          requestId: page.dataset["requestId"],
          causeName: cause instanceof Error ? cause.name : cause.constructor.name,
        },
      }),
    );
  };
  const joints = bindRigJoints(
    page.querySelector<HTMLElement>("[data-rig-source-area]")!,
    page.querySelector<HTMLElement>("[data-rig-joint-status]")!,
    () => void rebuild(),
  );
  const portrait = upperBodyFrame(
    width,
    height,
    joints.current(),
    layers.filter(({ node }) => node.dataset["rigGroup"] === "body").map(({ layer }) => layer),
  );
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow errors from model preparation and the runtime loader
  const initializationFailure = (cause: unknown) => {
    fail(cause instanceof Error ? cause : new Error("Rig preview initialization failed"));
    if (cause instanceof Error && cause.message.startsWith("레이어의"))
      status.textContent = cause.message;
  };
  const displayComparison = (ordered: readonly RigLayerBinding[]) => {
    if (comparison.value !== "original" && comparison.value !== "flat") return false;
    release();
    modelRoot = comparisonRoot(document, comparison.value, image.src, ordered, width, height);
    const rendered = modelRoot;
    for (const preview of rendered.querySelectorAll("img"))
      preview.addEventListener(
        "error",
        (event) => {
          if (!disposed && modelRoot === rendered) fail(event);
        },
        { once: true },
      );
    host.replaceChildren(modelRoot);
    fit();
    page.dataset["rigState"] = "static";
    enableMotion(false);
    status.textContent = `${comparison.selectedOptions[0]!.textContent} · 리깅·표정 없음 · 같은 상체 구도`;
    return true;
  };
  const clearEmptyPreview = (activeCount: number, showFace: boolean) => {
    if (activeCount !== 0 || showFace || comparison.value === "original") return false;
    release();
    modelRoot = undefined;
    host.replaceChildren();
    pause.disabled =
      restart.disabled =
      rest.disabled =
      bent.disabled =
      headLeft.disabled =
      headRight.disabled =
        true;
    page.dataset["rigState"] = "empty";
    status.textContent = "표시할 레이어가 없습니다. 대상이나 개별 표시를 선택하세요.";
    return true;
  };
  const createLivePreview = async (
    observed: number,
    ordered: readonly RigLayerBinding[],
    showFace: boolean,
  ) => {
    const model = await createRigTestModel(width, height, joints.current(), ordered);
    if (obsolete(observed)) return;
    const root = document.createElement("div");
    root.className = "rig-test-render-root";
    const bounds = framing.value === "full" ? ([0, 0, width, height] as const) : portrait;
    const fitted = fitRigFrame(bounds, width, height, stage.clientWidth, stage.clientHeight);
    const next = await createRuntime(
      root,
      model,
      textures,
      rigViewport(fitted, stage.clientWidth, stage.clientHeight),
    );
    if (obsolete(observed)) {
      next.dispose();
      return;
    }
    release();
    runtime = next;
    modelRoot = root;
    host.replaceChildren(root);
    runtime.player.play(comparison.value === "rig" ? "rest" : motion.value, {
      loop: true,
      alpha: Number(strength.value),
    });
    face = showFace ? bindRigFace(page, runtime.player, faceParts, width) : undefined;
    runtime.player.frame(0);
    pause.disabled =
      restart.disabled =
      reset.disabled =
      rest.disabled =
      bent.disabled =
      headLeft.disabled =
      headRight.disabled =
        false;
    enableMotion(comparison.value !== "rig");
    fit();
    report();
  };
  const rebuild = async () => {
    const observed = ++revision;
    page.dataset["rigState"] = "loading";
    status.textContent = "분리 PNG를 관절에 연결하고 있습니다…";
    try {
      const diagnostic = comparison.value !== "live";
      faceFields.disabled = diagnostic;
      const showFace = !diagnostic && faceReady && view.value !== "outfit";
      const active = layers.filter(
        ({ node, layer }) =>
          node.querySelector<HTMLInputElement>("[data-rig-layer-enabled]")!.checked &&
          (diagnostic
            ? node.dataset["rigGroup"] === "body"
            : view.value === "all" || node.dataset["rigGroup"] === view.value) &&
          !(showFace && node.dataset["rigGroup"] === "body" && layer.plane === "face"),
      );
      if (clearEmptyPreview(active.length, showFace)) return;
      const bindings = active.map(({ node, layer }) => ({
        layer,
        bone: node.querySelector<HTMLSelectElement>("[data-rig-layer-bone]")!.value,
        texture: node.dataset["rigTexture"]!,
      }));
      const ordered = composeFaceBindings(bindings, showFace ? faceParts : [], width, height);
      if (displayComparison(ordered)) return;
      await createLivePreview(observed, ordered, showFace);
    } catch (cause) {
      if (!obsolete(observed)) initializationFailure(cause);
    }
  };
  const tick = (now: number) => {
    if (disposed) return;
    if (runtime && comparison.value !== "rig" && !paused && !document.hidden) {
      const dt = Math.min(0.05, (now - last) / 1000);
      face?.tick(dt);
      runtime.player.frame(dt);
    }
    last = now;
    frame = window.requestAnimationFrame(tick);
  };
  motion.addEventListener("change", () => {
    if (!runtime) return;
    runtime.player.play(motion.value, { loop: true, alpha: Number(strength.value), mix: 0.15 });
    runtime.player.frame(0);
    report();
  });
  strength.addEventListener("input", () => {
    if (!runtime) return;
    runtime.player.setAlpha(0, Number(strength.value));
    runtime.player.frame(0);
    report();
  });
  pause.addEventListener("click", () => {
    paused = !paused;
    pause.textContent = paused ? "재생" : "일시정지";
    report();
  });
  restart.addEventListener("click", () => {
    runtime!.player.play(motion.value, { loop: true, alpha: Number(strength.value) });
    runtime!.player.frame(0);
  });
  reset.addEventListener("click", () => joints.reset());
  const pose = (name: string, time: number) => {
    if (!runtime) return;
    motion.value = name;
    runtime.player.play(name, { loop: true, alpha: Number(strength.value) });
    runtime.player.frame(time);
    paused = true;
    pause.textContent = "재생";
    report();
  };
  rest.addEventListener("click", () => pose("rest", 0));
  bent.addEventListener("click", () => pose("elbows", 1));
  headLeft.addEventListener("click", () => pose("nod", 1));
  headRight.addEventListener("click", () => pose("nod", 3));
  view.addEventListener("change", () => void rebuild());
  comparison.addEventListener("change", () => void rebuild());
  framing.addEventListener("change", fit);
  const backdrop = page.querySelector<HTMLSelectElement>("[data-rig-backdrop]")!;
  backdrop.addEventListener("change", () => {
    stage.style.backgroundColor = backdrop.value;
  });
  for (const { node } of layers) {
    node.querySelector("[data-rig-layer-bone]")!.addEventListener("change", () => void rebuild());
    node
      .querySelector("[data-rig-layer-enabled]")!
      .addEventListener("change", () => void rebuild());
  }
  image.addEventListener("load", () => void rebuild(), { once: true });
  image.addEventListener("error", fail, { once: true });
  const observer = new window.ResizeObserver(fit);
  observer.observe(stage);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    revision++;
    window.cancelAnimationFrame(frame);
    observer.disconnect();
    release();
  };
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) dispose();
  });
  frame = window.requestAnimationFrame(tick);
  if (image.complete) {
    if (image.naturalWidth > 0) void rebuild();
    else fail(new Error("Image not readable"));
  }
  return dispose;
}
