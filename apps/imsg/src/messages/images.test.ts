import { Effect, FileSystem } from "effect";
import { expect, test } from "vitest";
import { imageData, imageMime } from "./images.ts";
import { mediaFixtures } from "../../test/media.test-helper.ts";

const attachment = (mimeType: string | null, uti: string | null = null, missing = false) => ({
  path: "/private/Messages/photo.heic",
  mimeType,
  uti,
  missing,
});

test("converts HEIC via sips, and sends only inline data URLs", async () => {
  const fixture = mediaFixtures();
  const result = await Effect.runPromise(
    imageData(attachment("image/heic")).pipe(Effect.provide(fixture.layer)),
  );
  expect(result).toEqual({
    uri: `data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}`,
  });
  expect(fixture.commands).toEqual([
    [
      "/usr/bin/sips",
      "-s",
      "format",
      "jpeg",
      "-Z",
      "1600",
      "/private/Messages/photo.heic",
      "--out",
      "/test-temp/photo.jpeg",
    ],
  ]);
  expect(
    await Effect.runPromise(imageData(attachment("image/png")).pipe(Effect.provide(fixture.layer))),
  ).toEqual({ uri: `data:image/png;base64,${Buffer.from("raw").toString("base64")}` });
  expect(fixture.commands).toHaveLength(1);
  expect(imageMime(attachment(null, "public.heic"))).toBe("image/heic");
  expect(imageMime(attachment("image/heif"))).toBe("image/heic");
  expect(imageMime(attachment(null, "public.heif"))).toBe("image/heic");
  expect(imageMime(attachment(null, "public.jpeg"))).toBe("image/jpeg");
  expect(imageMime(attachment(null, "public.png"))).toBe("image/png");
  expect(imageMime(attachment(null, "com.compuserve.gif"))).toBe("image/gif");
  expect(imageMime(attachment(null, "org.webmproject.webp"))).toBe("image/webp");
  expect(imageMime(attachment("image/gif"))).toBe("image/gif");
  expect(imageMime(attachment("image/webp"))).toBe("image/webp");
  expect(imageMime(attachment("application/pdf"))).toBeNull();
  const missingFiles = await Effect.runPromise(Effect.flip(imageData(attachment("image/png"))));
  expect(missingFiles.message).toContain("Cannot open image: Error: FileSystem unavailable");
  const missingProcess = await Effect.runPromise(
    Effect.flip(imageData(attachment("image/heic")).pipe(Effect.provide(FileSystem.layerNoop({})))),
  );
  expect(missingProcess.message).toContain(
    "Cannot open image: Error: ChildProcessSpawner unavailable",
  );
});
