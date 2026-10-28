import worker, { ApiApplication, DiscoveryActivity, HealthMonitor } from "../worker/entry.ts";
import { executionSnapshot } from "./execution-catalog.ts";
import { Schema } from "effect";

const catalog = [
  {
    id: "sora",
    name: "Sora",
    bio: "A musician",
    imageUrl: "https://admin.example/sora.jpg",
    publicProfile: "A musician",
  },
];

const fakeUpstreams: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.hostname === "api-msg.example" && url.pathname === "/health")
    return Response.json({ service: "api-msg", revision: "development", status: "ready" });
  if (url.hostname === "api-msg.example" && url.pathname.startsWith("/imsg/rpc")) {
    const body = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Number }))(
      await new Request(input, init).json(),
    );
    return new Response(
      `${JSON.stringify({ _tag: "Exit", requestId: body.id, exit: { _tag: "Success", value: null } })}\n`,
    );
  }
  if (url.hostname === "admin.example" && url.pathname === "/api/personas")
    return Response.json(catalog);
  if (url.hostname === "large-admin.example" && url.pathname === "/api/personas")
    return Response.json(
      Array.from({ length: 110 }, (_, index) => ({
        ...catalog[0],
        id: `persona-${index}`,
        portraits: {
          anime: `https://images.example/${index}-anime.png`,
          photo: `https://images.example/${index}-photo.png`,
        },
      })),
    );
  if (url.hostname === "admin.example" && url.pathname === "/api/catalog")
    return Response.json({
      ...executionSnapshot(),
      personas: executionSnapshot().personas.map((record) => ({
        ...record,
        persona: { ...record.persona, id: "sora" },
      })),
    });
  if (url.hostname === "challenges.cloudflare.com") return Response.json({ success: true });
  if (url.hostname === "admin.example" && url.pathname.startsWith("/discovery/images/"))
    return new Response("catalog image");
  return new Response("Unexpected test upstream", { status: 502 });
};

globalThis.fetch = fakeUpstreams;

export { ApiApplication, DiscoveryActivity, HealthMonitor };
export default {
  fetch(request: Request, env: Parameters<typeof worker.fetch>[1]) {
    const mode = request.headers.get("X-Activity-Fixture");
    return worker.fetch(request, {
      ...env,
      ...(mode && {
        ACTIVITY_LIMIT: {
          limit: async () => {
            if (mode === "limiter-offline")
              throw Object.assign(new Error("private-upstream"), { code: "LIMITER_OFFLINE" });
            return { success: mode !== "limited" };
          },
        },
      }),
      ...(mode === "storage-offline" && {
        ACTIVITY: {
          idFromName: (name: string) => env.ACTIVITY.idFromName(name),
          get: () => ({
            fetch: async () => {
              throw new Error("private-storage");
            },
          }),
        },
      }),
    });
  },
};
