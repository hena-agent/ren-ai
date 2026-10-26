export const personaImageBase = "https://persona-images.renai.im/";
export const imageFilenamePattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(png|jpg|webp)$/;
/** Display renditions share their original's UUID; they are never persona photos themselves. */
export const thumbnailFilenamePattern =
  /^thumbnails\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jpg$/;

export function ownedImageKey(url: string) {
  const base = url.startsWith(personaImageBase)
    ? personaImageBase
    : (url.match(/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]+\/images\//)?.[0] ??
      "/images/");
  const key = url.slice(base.length);
  return url.startsWith(base) && imageFilenamePattern.test(key) ? key : undefined;
}

export const thumbnailKey = (key: string) =>
  `thumbnails/${key.replace(/\.(png|jpg|webp)$/, ".jpg")}`;

/** The stored display rendition of a service-owned image; other images have none. */
export function thumbnailUrl(url: string) {
  const key = ownedImageKey(url);
  return key ? `${url.slice(0, -key.length)}${thumbnailKey(key)}` : url;
}
