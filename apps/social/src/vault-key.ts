import { randomBytes } from "node:crypto";
import { mkdir, chmod, readFile, writeFile, link, rm } from "node:fs/promises";
import { join } from "node:path";

/** Publish a complete key exclusively: concurrent account saves must never rotate it. */
export async function vaultKey(directory: string, explicit: string | undefined, create = false) {
  const path = join(directory, ".encryption-key");
  const read = async () => {
    const hex = (explicit ?? (await readFile(path, "utf8"))).trim();
    if (!/^[a-fA-F0-9]{64}$/.test(hex))
      throw Object.assign(new Error("Invalid authentication encryption key"), {
        code: "SOCIAL_VAULT_KEY",
      });
    return Buffer.from(hex, "hex");
  };
  try {
    return await read();
  } catch (cause) {
    if (
      !create ||
      explicit !== undefined ||
      !(cause instanceof Error) ||
      !("code" in cause) ||
      cause.code !== "ENOENT"
    )
      throw cause;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
    try {
      await link(temporary, path);
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return read();
}
