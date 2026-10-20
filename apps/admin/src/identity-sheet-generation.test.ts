import { expect, test, vi } from "vitest";
import { createProfileGenerator } from "./generation.ts";
import { character, portraitImage, portraitReply } from "../test/fixtures.ts";

test("sheet requests use three neutral views and landscape output, with only an explicitly supplied same-style reference", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(portraitReply);
  const generator = createProfileGenerator({ key: "test-key", fetcher });
  expect(await generator.sheet(character, "anime")).toEqual(portraitImage);
  await expect(new Request(...fetcher.mock.calls[0]!).json()).resolves.toMatchObject({
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "3:2", imageSize: "1K" },
    },
  });
  expect(await new Request(...fetcher.mock.calls[0]!).text()).toContain(
    "front, three-quarter and true side profile",
  );
  expect(await new Request(...fetcher.mock.calls[0]!).text()).not.toContain(
    "SELF-CHOSEN DATING PROFILE PHOTO",
  );
  await generator.sheet(character, "photo", "private identity detail", portraitImage);
  expect(await new Request(...fetcher.mock.calls[1]!).json()).toMatchObject({
    contents: [
      {
        parts: [
          {},
          {
            inlineData: {
              mimeType: portraitImage.mimeType,
              data: portraitImage.bytes.toString("base64"),
            },
          },
        ],
      },
    ],
  });
  expect(await new Request(...fetcher.mock.calls[1]!).text()).toContain("private identity detail");
});
