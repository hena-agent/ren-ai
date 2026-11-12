export function artworkLayerQuality(
  original: ArrayLike<number>,
  composite: ArrayLike<number>,
  foreground: ArrayLike<number>,
  width: number,
  height: number,
) {
  const length = width * height * 4;
  if (
    width < 1 ||
    height < 1 ||
    original.length !== length ||
    composite.length !== length ||
    foreground.length !== length
  )
    throw new Error("Image comparison dimensions do not match");
  const missingMask = new Uint8ClampedArray(length),
    differenceMask = new Uint8ClampedArray(length);
  let pixels = 0,
    missing = 0,
    different = 0,
    totalError = 0;
  for (let i = 0; i < length; i += 4) {
    if (original[i + 3]! < 200 || Math.min(original[i]!, original[i + 1]!, original[i + 2]!) >= 220)
      continue;
    pixels++;
    const red = Math.abs(original[i]! - composite[i]!);
    const green = Math.abs(original[i + 1]! - composite[i + 1]!);
    const blue = Math.abs(original[i + 2]! - composite[i + 2]!);
    totalError += red + green + blue;
    if (foreground[i + 3]! < 16) {
      missing++;
      missingMask.set([255, 30, 90, 210], i);
    }
    if (Math.max(red, green, blue) > 40) {
      different++;
      differenceMask.set([30, 140, 255, 180], i);
    }
  }
  return {
    pixels,
    missing,
    different,
    missingPercent: pixels ? (missing / pixels) * 100 : 0,
    differentPercent: pixels ? (different / pixels) * 100 : 0,
    meanColorError: pixels ? totalError / pixels / 3 : 0,
    missingMask,
    differenceMask,
  };
}
export type ArtworkLayerQuality = ReturnType<typeof artworkLayerQuality>;
