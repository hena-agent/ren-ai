import { expect, test } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rigArtworkFiles } from "./rig-artwork.ts";
import type { RigArtworkImage } from "./rig-artwork-model.ts";

test("each persona has one persistent artwork with atomic compare-and-swap replacement and an in-flight lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "persona-artwork-"));
  const first: RigArtworkImage = {
    model: "seedream-5-lite",
    operationId: "first",
    imageUrl: "/images/11111111-1111-4111-8111-111111111111.png",
  };
  const second: RigArtworkImage = {
    model: "flux-2-klein-9b",
    operationId: "second",
    imageUrl: "/images/22222222-2222-4222-8222-222222222222.png",
  };
  try {
    const store = rigArtworkFiles(directory);
    expect(await store.rigArtwork("harin")).toBeUndefined();
    await expect(store.rigArtwork("../escape")).rejects.toMatchObject({ kind: "invalid" });
    await expect(store.saveRigArtwork("../escape", first)).rejects.toMatchObject({
      kind: "invalid",
    });
    await expect(
      store.saveRigArtwork("harin", { ...first, imageUrl: "https://outside.test/image.png" }),
    ).rejects.toMatchObject({ kind: "invalid" });
    const attempts = await Promise.allSettled([
      store.saveRigArtwork("harin", first),
      store.saveRigArtwork("harin", second),
    ]);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["fulfilled", "rejected"]);
    await expect(store.saveRigArtwork("harin", second)).rejects.toMatchObject({ kind: "conflict" });
    await store.saveRigArtwork("harin", second, first.operationId);
    await store.saveRigArtwork("other", first);
    const reopened = rigArtworkFiles(directory);
    expect(await reopened.rigArtwork("harin")).toEqual(second);
    expect(await reopened.rigArtwork("other")).toEqual(first);
    expect(await readdir(join(directory, "rig-artworks"))).toEqual(["harin.json", "other.json"]);
    await mkdir(join(directory, "rig-artworks", "bad.json"));
    await expect(reopened.rigArtwork("bad")).rejects.toMatchObject({ code: "EISDIR" });
    await writeFile(join(directory, "rig-artworks", "corrupt.json"), '{"model":""}');
    await expect(reopened.rigArtwork("corrupt")).rejects.toThrow(/model/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
