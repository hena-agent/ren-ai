import { Effect } from "effect";
import { loadPersonas } from "./personas/personas.ts";
import { isolatedHost } from "./opencode/isolate.ts";
import type { HostOptions } from "./opencode/host.ts";
export { serveViewer, viewerFront } from "./opencode/viewer.ts";

export const startPersonaHost = (root: string, options: Omit<HostOptions, "personas">) =>
  Effect.flatMap(loadPersonas(options.personaDirectory), (personas) =>
    isolatedHost(root, { ...options, personas }),
  );
