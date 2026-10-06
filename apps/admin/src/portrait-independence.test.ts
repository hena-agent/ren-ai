import { expect, test, vi } from "vitest";
import {
  character,
  femaleCharacter,
  fixture,
  generator,
  newToken,
  portraitImage,
  portraitReply,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import { createProfileGenerator } from "./generation.ts";
import { draftTokens } from "./draft.ts";
import policy from "./policy.json";
import { parsePersona } from "@ren-ai/personas";

test("both portrait styles receive only their own art direction and the same private character description", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(portraitReply);
  const model = createProfileGenerator({ key: "key", fetcher });
  for (const style of ["anime", "photo"] as const) {
    await model.portrait(character, style, "warm atmosphere");
    expect(await new Request(...fetcher.mock.calls.at(-1)!).json()).toEqual({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${policy.portraits[style]}${style === "photo" ? `\n\n${policy.photoSceneDirection}` : ""}\n\n${policy.profilePhotoDirection}\n\n${policy.genderDirection}\n\n${character.name}\n${character.description}\n\nADDITIONAL PORTRAIT INSTRUCTIONS:\nwarm atmosphere`,
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "4:5", imageSize: "1K" },
      },
    });
  }
});

test("the two independent main styles run one at a time and both results become a private preview", async () => {
  let release: (image: typeof portraitImage) => void =
    vi.fn<(image: typeof portraitImage) => void>();
  const ready = new Promise<typeof portraitImage>((resolve) => {
    release = resolve;
  });
  const portrait = vi
    .fn<typeof generator.portrait>()
    .mockImplementationOnce(() => ready)
    .mockResolvedValue(portraitImage);
  const { admin, store, logs } = await fixture({ ...generator, portrait });
  const saved = vi.spyOn(store, "saveImage");
  const pending = admin(
    request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(1));
  expect(portrait.mock.calls).toEqual([[femaleCharacter, "anime"]]);
  expect(saved).not.toHaveBeenCalled();
  expect(
    logs
      .filter(
        (entry) => entry.event === "operation.completed" && entry.stage === "portrait.generate",
      )
      .map((entry) => entry.style),
  ).toEqual([]);
  release(portraitImage);
  const response = await pending;
  expect(response.status).toBe(200);
  expect(saved).toHaveBeenCalledTimes(2);
  expect(portrait.mock.calls).toEqual([
    [femaleCharacter, "anime"],
    [femaleCharacter, "photo"],
  ]);
  const draft = draftTokens("test-password").decode(tokenOf(await response.text()));
  const pair = parsePersona(draft.id, draft.preview).portraits;
  expect(pair?.anime).toMatch(/^\/discovery\/images\//);
  expect(pair?.photo).toMatch(/^\/discovery\/images\//);
  expect(await store.list()).toEqual([]);
});

test("either style failing keeps the completed sibling as a partial preview and a subsequent retry can replace both", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockResolvedValue(portraitImage);
  const { admin, store } = await fixture({ ...generator, portrait });
  const generated = await (
    await admin(
      request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
    )
  ).text();
  const token = tokenOf(generated);
  const previous = draftTokens("test-password").decode(token).preview;
  for (const style of ["anime", "photo"] as const) {
    portrait.mockImplementation(async (_character, current) => {
      if (current === style) throw new Error("model unavailable");
      return portraitImage;
    });
    const failed = await admin(
      request("/personas", {
        ...character,
        draft: token,
        intent: "portrait",
        portraitInstructions: style,
      }),
    );
    expect(failed.status).toBe(503);
    const partial = draftTokens("test-password").decode(tokenOf(await failed.text()));
    const record = parsePersona(partial.id, partial.preview);
    expect(record.portraits?.[style]).toBeUndefined();
    expect(record.portraits?.[style === "anime" ? "photo" : "anime"]).toMatch(
      /^\/discovery\/images\//,
    );
    expect(record.bio).toBe(parsePersona(partial.id, previous).bio);
    expect(await store.list()).toEqual([]);
  }
  portrait.mockResolvedValue(portraitImage);
  const retried = await admin(
    request("/personas", { ...character, draft: token, intent: "portrait" }),
  );
  expect(retried.status).toBe(200);
  expect(draftTokens("test-password").decode(tokenOf(await retried.text())).preview).not.toBe(
    previous,
  );
  expect(await store.list()).toEqual([]);
});
