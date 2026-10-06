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
} from "./fixtures.ts";

export const photoPortrait = {
  bytes: Buffer.from("ffd8ffe0", "hex"),
  mimeType: "image/jpeg" as const,
};
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
      intent: "subportrait",
      imageCount,
    }),
  );
export const initialProfile = async (admin: Admin, imageCount = "1") =>
  admin(
    request("/personas", {
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
  const page = await (
    await result.admin(
      request("/personas", {
        ...character,
        draft: await newToken(result.admin),
        intent: "generate",
        portraitInstructions: "extra",
      }),
    )
  ).text();
  return { ...result, page };
}
export async function savedPreview(model = subGenerator) {
  const result = await basePreview(model);
  const original = preview(result.page);
  const route = `/personas/${original.id}`;
  await result.store.create(original);
  return { ...result, original, route, editing: await (await result.admin(request(route))).text() };
}
export const modelReply = (text: string) =>
  Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
