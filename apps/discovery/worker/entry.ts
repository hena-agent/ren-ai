import { discoveryServer } from "../src/server.ts";
import type { DiscoveryEnv } from "../src/server.ts";

declare const caches: CacheStorage & { default: Cache };
const serve = discoveryServer();
export default {
  fetch: (request: Request, env: DiscoveryEnv) => serve(request, env, caches.default),
};
