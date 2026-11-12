import type { PersonaStore } from "@ren-ai/personas";
import type { AdminOptions } from "./admin-options.ts";
import type { ImageModels } from "./image-model.ts";
import { imageModelRoute } from "./image-model-route.ts";
import { contactRoutes } from "./contact-routes.ts";
import { metricsRoutes } from "./metrics-routes.ts";
import { conversationRoutes } from "./conversation-routes.ts";
import { socialRoutes } from "./social-routes.ts";
import { socialImageResponse } from "./social-image-response.ts";
import { rigTestPage } from "./rig-test-page.tsx";
import type { ArtworkLayerizer } from "./artwork-layer-generation.ts";
import { artworkLayerOptions } from "./artwork-layer-options.ts";
import { artworkLayerPage } from "./artwork-layer-page.tsx";
import { saveArtworkLayerLayout } from "./artwork-layer-layout.ts";
import { saveRigFace } from "./rig-face-save.ts";

export function managementResponse(
  request: Request,
  url: URL,
  management: AdminOptions["management"],
  store: PersonaStore,
  models: ImageModels | undefined,
  layers: ArtworkLayerizer | undefined,
  locked: (id: string) => boolean,
) {
  if (url.pathname === "/image-models") return imageModelRoute(request, models);
  if (url.pathname === "/artwork-layer-options") return artworkLayerOptions(request, store, layers);
  if (url.pathname.endsWith("/artwork-layers")) return artworkLayerPage(request, url, store);
  if (url.pathname.endsWith("/artwork-layers/layout"))
    return saveArtworkLayerLayout(request, url, store, locked);
  if (url.pathname.endsWith("/rig-test")) return rigTestPage(request, url, store);
  if (url.pathname.endsWith("/rig-face")) return saveRigFace(request, url, store, locked);
  if (url.pathname === "/social") return socialRoutes(request, store, management?.social);
  if (url.pathname.startsWith("/social/images/"))
    return socialImageResponse(request, management?.social);
  if (["/waitlist", "/first-contacts", "/invitations"].includes(url.pathname))
    return contactRoutes(request, management);
  if (url.pathname === "/metrics") return metricsRoutes(request, management);
  if (url.pathname.startsWith("/conversations"))
    return conversationRoutes(request, management?.conversations);
  return undefined;
}
