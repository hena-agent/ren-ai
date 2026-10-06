import { expect, test, vi } from "vitest";
import { createProfileGenerator } from "./generation.ts";
import policy from "./policy.json";
import { character, generator, request, tokenOf } from "../test/fixtures.ts";
import { basePreview, modelReply, preview } from "../test/sub-portraits.ts";

test("biography rewrites generate the character's own first-person profile text without touching any image or leaking private material", async () => {
  const introduction = vi
    .fn<typeof generator.introduction>()
    .mockResolvedValue("말 걸기 전에 커피부터 골라요. 취향이 겹치면 얘기가 길어질지도요.");
  const { admin, page, store } = await basePreview({ ...generator, introduction });
  introduction.mockClear();
  const before = preview(page);
  const rewritten = await admin(
    request("/personas", { ...character, draft: tokenOf(page), intent: "introduction" }),
  );
  expect(rewritten.status).toBe(200);
  const after = preview(await rewritten.text());
  expect(introduction).toHaveBeenCalledTimes(1);
  expect(after.portraits).toEqual(before.portraits);
  expect(after.secondaryPortraits).toEqual(before.secondaryPortraits);
  expect(await store.list()).toEqual([]);
});

test("self-presentation direction is applied to personal biography at the actual provider boundary", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(modelReply("먼저 웃어주면 저도 말이 많아져요."));
  const model = createProfileGenerator({ key: "key", fetcher });
  expect(await model.introduction(character)).toBe("먼저 웃어주면 저도 말이 많아져요.");
  expect(await new Request(...fetcher.mock.calls[0]!).json()).toMatchObject({
    contents: [
      {
        parts: [
          {
            text: `${policy.introduction}\n\n${policy.genderDirection}\n\n${character.name}\n${character.description}`,
          },
        ],
      },
    ],
  });
  expect(policy.introduction).toContain("본인이 고른 1인칭 자기표현");
  expect(policy.profilePhotoDirection).toContain("self");
});
