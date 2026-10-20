import { expect, test, vi } from "vitest";
import { withPublicProfile, splitPersonaMarkdown } from "@ren-ai/personas/profile";
import {
  character,
  femaleCharacter,
  fixture,
  generator,
  legacy,
  portraitImage,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import { preview } from "../test/sub-portraits.ts";

test.each(["legacy public age", "no introduction"])(
  "an existing photo can create an identity sheet without changing or validating the profile (%s)",
  async (profile) => {
    const sheet = vi.fn<typeof generator.sheet>().mockResolvedValue(portraitImage);
    const convert = vi
      .fn<typeof generator.convert>()
      .mockRejectedValue(new Error("Sheet work must not rewrite the Persona"));
    const { admin, store } = await fixture({ ...generator, sheet, convert });
    const imageUrl = await store.saveImage(portraitImage);
    const description =
      profile === "legacy public age"
        ? withPublicProfile(character.description, "반가워요.\n\n### 기본 정보\n- 나이: 26세")
        : splitPersonaMarkdown(character.description).privateMarkdown;
    const original = await store.create({
      ...legacy,
      ...femaleCharacter,
      id: "existing-sheet-source",
      description,
      prompt: description,
      imageUrl,
      portraits: { anime: imageUrl },
      published: profile === "legacy public age",
    });
    const source = await store.source(original.id);
    const route = `/personas/${original.id}`;
    const editing = await (await admin(request(route))).text();
    const response = await admin(
      request(`${route}?style=anime&image=${encodeURIComponent(imageUrl)}`, {
        name: original.name,
        description,
        draft: tokenOf(editing),
        intent: "sheet",
        ...(original.published && { published: "on" }),
      }),
    );
    expect(response.status).toBe(200);
    const completed = await response.text();
    expect(completed).not.toContain('data-state="blocked"');
    expect(sheet).toHaveBeenCalledExactlyOnceWith(
      { name: original.name, description, gender: "female" },
      "anime",
      "",
      portraitImage,
    );
    expect(convert).not.toHaveBeenCalled();
    expect(preview(completed)).toEqual(original);
    expect(await store.source(original.id)).toBe(source);
    expect((await store.sheets(original.id)).anime).toBeTruthy();
    const photo = await admin(
      request(`${route}?style=anime`, {
        name: original.name,
        description,
        draft: tokenOf(completed),
        intent: "generate",
        ...(original.published && { published: "on" }),
      }),
    );
    expect(photo.status).toBe(200);
    expect(preview(await photo.text()).description).toBe(description);
    expect(convert).not.toHaveBeenCalled();
    expect(await store.source(original.id)).toBe(source);
  },
);
