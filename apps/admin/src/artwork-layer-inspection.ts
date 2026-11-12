import { artworkLayerQuality } from "./artwork-layer-quality.ts";

async function loadImage(document: Document, url: string) {
  const image = new document.defaultView!.Image();
  image.crossOrigin = "anonymous";
  image.src = url;
  await image.decode();
  return image;
}

export async function inspectArtworkLayers(
  page: HTMLElement,
  load = (url: string) => loadImage(page.ownerDocument, url),
) {
  const stage = page.querySelector<SVGSVGElement>(".layer-canvas")!;
  const width = Number(stage.getAttribute("width")),
    height = Number(stage.getAttribute("height"));
  const contexts = Array.from({ length: 3 }, () => {
    const canvas = page.ownerDocument.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas image inspection is unavailable");
    return context;
  });
  const [source, composite, foreground] = contexts;
  const original = page.querySelector<SVGImageElement>("[data-layer-original]")!;
  source!.drawImage(await load(original.getAttribute("href")!), 0, 0, width, height);
  composite!.fillStyle = "white";
  composite!.fillRect(0, 0, width, height);
  for (const node of stage.querySelectorAll<SVGImageElement>("[data-layer-image]")) {
    const image = await load(node.getAttribute("href")!);
    const geometry = ["x", "y", "width", "height"].map((name) => Number(node.getAttribute(name)));
    composite!.drawImage(image, geometry[0]!, geometry[1]!, geometry[2]!, geometry[3]!);
    if (node.dataset["layerImage"] !== "0")
      foreground!.drawImage(image, geometry[0]!, geometry[1]!, geometry[2]!, geometry[3]!);
  }
  return artworkLayerQuality(
    source!.getImageData(0, 0, width, height).data,
    composite!.getImageData(0, 0, width, height).data,
    foreground!.getImageData(0, 0, width, height).data,
    width,
    height,
  );
}
