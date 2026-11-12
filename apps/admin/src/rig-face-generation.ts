import { PhotonImage, crop, resize, SamplingFilter } from "@cf-wasm/photon";
import type { RigArtworkImage, RigArtworkLayer } from "@ren-ai/personas/rig-artwork";
import { PersonaError } from "@ren-ai/personas";

export const rigFaceDirection = `Edit the supplied close-up of ONE adult fictional woman's face. Preserve exactly her identity, facial proportions, face outline, nose, ears, hair, camera, head angle, lighting, skin tone, linework, and illustration style. Preserve the original framing and feature positions. This is an aligned facial animation asset, not a redesigned character, beauty retouch, reference sheet, multiple views, or a scene. Make one image only, with no text, labels, symbols, watermarks, or layout changes. Change only the explicitly requested facial features. Keep the plain white background and existing neck/shoulders. Do not add or alter clothing or the body.`;
export const faceGenerationDirections = {
  base: "Create a clean facial skin plate for animation: remove BOTH eyes (including iris, pupil, sclera, eyelids, eyelashes and eye makeup), BOTH eyebrows and the mouth/lips. Fill ONLY those small feature regions with continuous natural matching facial skin and shading. Preserve the nose, philtrum outside the lips, chin, face outline, ears, hair, neck, and all other pixels as closely as possible. No empty eye sockets, scars, black marks, or replacement features.",
  closed:
    "Close BOTH eyes softly and naturally, preserving their exact placement and width. Draw clean relaxed closed eyelids and lashes. Keep the eyebrows relaxed. Give her a small gentle closed-mouth smile. Do not squint aggressively or change her face shape. The closed eyes and smile will be extracted as separate animation parts.",
  surprised:
    "Give her a subtle surprised expression: open BOTH eyes slightly wider, raise the eyebrows slightly, and open her mouth a little with a clean, dark interior. No exaggerated cartoon distortion, blush symbols or tears. Preserve the placement and identity of her eyes and lips. The eyes, eyebrows and mouth will be extracted as separate animation parts.",
};

export function faceReference(bytes: Uint8Array, artwork: RigArtworkImage, face: RigArtworkLayer) {
  const layers = artwork.layers!;
  const [x0, y0, x1, y1] = face.bounds;
  if (
    !face.bounds.every(Number.isFinite) ||
    x0 < 0 ||
    y0 < 0 ||
    x1 <= x0 ||
    y1 <= y0 ||
    x1 > layers.width ||
    y1 > layers.height
  )
    throw new PersonaError("invalid", "얼굴 레이어의 위치·크기를 확인하세요.");
  const center = (face.bounds[0] + face.bounds[2]) / 2;
  const width = Math.min(layers.width, (face.bounds[2] - face.bounds[0]) * 1.6);
  const height = Math.min(layers.height, width * 1.5);
  const left = Math.max(0, Math.min(layers.width - width, center - width / 2));
  const top = Math.max(0, Math.min(layers.height - height, face.bounds[1] - height * 0.17));
  const bounds = [left, top, left + width, top + height] as const;
  const original = PhotonImage.new_from_byteslice(bytes);
  try {
    const sx = original.get_width() / layers.width,
      sy = original.get_height() / layers.height;
    const clipped = crop(
      original,
      Math.floor(left * sx),
      Math.floor(top * sy),
      Math.max(1, Math.ceil(bounds[2] * sx)),
      Math.max(1, Math.ceil(bounds[3] * sy)),
    );
    try {
      const scaled = resize(clipped, 1024, 1536, SamplingFilter.Lanczos3);
      try {
        return { portrait: { bytes: scaled.get_bytes(), mimeType: "image/png" as const }, bounds };
      } finally {
        scaled.free();
      }
    } finally {
      clipped.free();
    }
  } finally {
    original.free();
  }
}
