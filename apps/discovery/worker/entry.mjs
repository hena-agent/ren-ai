import { catalogResponse } from "../src/catalog-response.ts";

export default {
  /** @param {Request} request @param {import('../src/catalog-response.ts').CatalogEnv & {ASSETS: Fetcher}} env */
  fetch(request, env) {
    if (new URL(request.url).pathname === "/api/personas") return catalogResponse(request, env);
    return env.ASSETS.fetch(request);
  },
};
