import { draftTokens, previewOf } from "../src/draft.ts";
import { emptyPersona } from "../src/authoring.ts";
import {
  character,
  fixture,
  generator,
  newToken,
  portraitImage,
  request,
  tokenOf,
  photoPortrait,
} from "./fixtures.ts";

export { photoPortrait } from "./fixtures.ts";
export const subPlan = (count: number) => ({
  reason: "private recommendation reason",
  scenes: Array.from({ length: count }, (_, index) => ({
    title: `추천 ${index + 1}`,
    direction: `private scene direction ${index + 1}`,
  })),
});
export const subGenerator: typeof generator = {
  ...generator,
  portrait: async (_character, style) => (style === "anime" ? portraitImage : photoPortrait),
};
type Admin = Awaited<ReturnType<typeof fixture>>["admin"];
export const addPortrait = (admin: Admin, page: string, style = "photo", imageCount = "1") =>
  admin(
    request(`/personas?style=${style}`, {
      ...character,
      draft: tokenOf(page),
      intent: "generate",
      imageCount,
    }),
  );
export const initialProfile = async (admin: Admin, imageCount = "1") =>
  admin(
    request("/personas?style=photo", {
      ...character,
      draft: await newToken(admin),
      intent: "generate",
      imageCount,
    }),
  );
export const publishPreview = (admin: Admin, page: string) =>
  admin(request("/personas", { ...character, draft: tokenOf(page), published: "on" }));
export function preview(page: string) {
  const draft = draftTokens("test-password").decode(tokenOf(page));
  return previewOf(draft, emptyPersona);
}
export async function basePreview(model = subGenerator) {
  const result = await fixture(model);
  let page = await (
    await result.admin(
      request("/personas?style=anime", {
        ...character,
        draft: await newToken(result.admin),
        intent: "generate",
        portraitInstructions: "extra",
      }),
    )
  ).text();
  page = await (
    await result.admin(
      request("/personas?style=photo", {
        ...character,
        draft: tokenOf(page),
        intent: "generate",
        portraitInstructions: "extra",
      }),
    )
  ).text();
  return { ...result, page };
}
export async function savedPreview(model = subGenerator) {
  const result = await basePreview(model);
  const original = await result.store.create(preview(result.page));
  const route = `/personas/${original.id}`;
  return { ...result, original, route, editing: await (await result.admin(request(route))).text() };
}
export const modelReply = (text: string) =>
  Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
