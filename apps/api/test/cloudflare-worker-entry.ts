import worker, { ApiApplication } from "../worker/entry.ts";
import { executionSnapshot } from "./execution-catalog.ts";

const catalog = [
  {
    id: "sora",
    name: "Sora",
    bio: "A musician",
    imageUrl: "https://admin.example/sora.jpg",
    publicProfile: "A musician",
  },
];

const fakeUpstreams: typeof fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.hostname === "admin.example" && url.pathname === "/api/personas")
    return Response.json(catalog);
  if (url.hostname === "admin.example" && url.pathname === "/api/catalog")
    return Response.json({
      ...executionSnapshot(),
      personas: executionSnapshot().personas.map((record) => ({ ...record, id: "sora" })),
    });
  if (url.hostname === "challenges.cloudflare.com") return Response.json({ success: true });
  if (url.hostname === "admin.example" && url.pathname.startsWith("/discovery/images/"))
    return new Response("catalog image");
  return new Response("Unexpected test upstream", { status: 502 });
};

globalThis.fetch = fakeUpstreams;

export { ApiApplication };
export default worker;
