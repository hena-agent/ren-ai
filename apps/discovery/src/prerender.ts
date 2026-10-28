import { publicResponse } from "./public-html.tsx";
import { publicOrigin } from "./public-routing.ts";

const page = (template: string, path: string) =>
  publicResponse(template, [], new URL(path, publicOrigin)).text();

/**
 * Home depends only on the build. Explorer and persona pages render into the application shell.
 */
export const staticPages = async (template: string) => ({
  "index.html": await page(template, "/"),
  "template.html": template,
});
