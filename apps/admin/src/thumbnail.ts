import { PhotonImage, resize, SamplingFilter } from "@cf-wasm/photon";
import { PersonaError } from "@ren-ai/personas";

// Covers Admin's widest image slot (~320 CSS px) on 2x displays.
const width = 640;

/** A display-size JPEG; generation references and full-size views keep the original. */
export function thumbnail(bytes: Uint8Array) {
  let original: PhotonImage;
  try {
    original = PhotonImage.new_from_byteslice(bytes);
  } catch (cause) {
    // Photon traps on undecodable bytes; other failures are infrastructure errors.
    if (!(cause instanceof WebAssembly.RuntimeError)) throw cause;
    const error = new PersonaError("invalid", "올바른 PNG, JPEG 또는 WebP 이미지가 필요합니다.");
    error.cause = cause;
    throw error;
  }
  try {
    const scale = Math.min(1, width / original.get_width());
    const resized = resize(
      original,
      Math.round(original.get_width() * scale),
      Math.max(1, Math.round(original.get_height() * scale)),
      SamplingFilter.Lanczos3,
    );
    try {
      return resized.get_bytes_jpeg(80);
    } finally {
      resized.free();
    }
  } finally {
    original.free();
  }
}
