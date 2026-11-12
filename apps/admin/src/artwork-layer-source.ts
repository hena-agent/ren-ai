import { PhotonImage, resize, SamplingFilter } from "@cf-wasm/photon";

/** Keep the entire source canvas and pose while providing a bounded provider upload. */
export function artworkLayerSource(bytes: Uint8Array) {
  const source = PhotonImage.new_from_byteslice(bytes);
  try {
    const scale = Math.min(1, 1536 / Math.max(source.get_width(), source.get_height()));
    const image = resize(
      source,
      Math.max(1, Math.round(source.get_width() * scale)),
      Math.max(1, Math.round(source.get_height() * scale)),
      SamplingFilter.Lanczos3,
    );
    try {
      return image.get_bytes_jpeg(95);
    } finally {
      image.free();
    }
  } finally {
    source.free();
  }
}
