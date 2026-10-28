import { publicResponse } from "./public-html.tsx";
import { publicOrigin } from "./public-routing.ts";
import { socialImage } from "./social-image.ts";

const page = (template: string, path: string) =>
  publicResponse(template, [], new URL(path, publicOrigin), socialImage(undefined, "anime")).text();

/**
 * Home and the explorer depend only on the build, so they ship as static files and never run the
 * Worker. Persona pages keep rendering into the unmodified application shell.
 */
export const staticPages = async (template: string) => ({
  "index.html": await page(template, "/"),
  "explore.html": await page(template, "/explore"),
  "template.html": template,
});
