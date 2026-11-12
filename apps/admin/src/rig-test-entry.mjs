import { loadModel, RigPlayer } from "@rig-c/play";
import { bindRigTest } from "./rig-test-browser.ts";

const page = document.querySelector("[data-rig-test]");
if (page)
  bindRigTest(page, async (root, model, images, viewport) => {
    const assets = await loadModel({
      modelUrl: location.href,
      fetch: async () => Response.json(model),
      resolvePage: (name) => {
        const url = images.get(name);
        if (!url) throw new Error("Rig texture is missing");
        return url;
      },
      crossOrigin: "anonymous",
      setsUrl: null,
      regions: "none",
    });
    try {
      const player = new RigPlayer(root, assets, { mode: "canvas", tracks: true });
      player.renderer.viewport = viewport;
      return {
        player,
        syncPixelRatio: (bounds) => {
          player.renderer.viewport = bounds;
          player.renderer.syncPixelRatio();
        },
        dispose: () => {
          player.dispose();
          assets.dispose();
        },
      };
    } catch (cause) {
      assets.dispose();
      throw cause;
    }
  });
