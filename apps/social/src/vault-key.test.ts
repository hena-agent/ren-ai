import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { vaultKey } from "./vault-key.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

test.each([
  new Error("Link failed"),
  Object.assign(new Error("Denied"), { code: "EACCES" }),
  "unexpected failure",
])("failed key publication never leaves staging files or a partial key (%s)", async (cause) => {
  const root = await fs.mkdtemp(join(tmpdir(), "social-key-"));
  roots.push(root);
  vi.spyOn(fs, "link").mockRejectedValueOnce(cause);
  await expect(vaultKey(root, undefined, true)).rejects.toBe(cause);
  expect(await fs.readdir(root)).toEqual([]);
  const key = await vaultKey(root, undefined, true);
  expect(await vaultKey(root, undefined)).toEqual(key);
});
