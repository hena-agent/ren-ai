export const personaImageBase = "https://persona-images.renai.im/";
export const imageFilenamePattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(png|jpg|webp)$/;

export function ownedImageKey(url: string) {
  const base = url.startsWith(personaImageBase)
    ? personaImageBase
    : (url.match(/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]+\/images\//)?.[0] ??
      "/images/");
  const key = url.slice(base.length);
  return url.startsWith(base) && imageFilenamePattern.test(key) ? key : undefined;
}
