import * as fs from "node:fs/promises";
import { join } from "node:path";
import { folderFiles, renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { managedFolder, sessionDirectory } from "@ren-ai/plugin-session-folder/paths";
import { expect, test, vi } from "vitest";
import { messagingFixture } from "../../test/messaging.test-helper.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

const snapshot = renderSnapshot(
  {
    id: "persona1",
    timeZone: "UTC",
    language: "en",
    openingLine: "Hi",
    memory: "Remember.",
    prompt: "Original.",
  },
  "Original rules.",
);
const withFiles = async (
  run: (files: ReturnType<typeof folderFiles>, directory: string) => Promise<void>,
) => {
  const { root, personaDirectory } = await messagingFixture("folder-files-");
  try {
    await run(folderFiles(personaDirectory), personaDirectory);
  } finally {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
};

test("new folder writes publish only complete snapshots and clean failed staging", () =>
  withFiles(async (files, directory) => {
    const write = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementation((path, ...args) =>
      typeof path === "string" && path.endsWith("/next/AGENTS.md")
        ? Promise.reject(new Error("Disk unavailable"))
        : write(path, ...args),
    );
    await expect(files.write("ses_initial", snapshot)).rejects.toThrow("Disk unavailable");
    expect(await files.exists("ses_initial")).toBe(false);
    expect(await fs.readdir(join(directory, "sessions"))).toEqual([]);
  }));

test("failed live writes preserve every old snapshot file and unrelated files", () =>
  withFiles(async (files, directory) => {
    const target = await files.write("ses_update", snapshot);
    await fs.writeFile(join(target, "unrelated.txt"), "Keep me.");
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation((from, to) =>
      String(to) === join(target, "opencode.json")
        ? Promise.reject(new Error("Commit unavailable"))
        : rename(from, to),
    );
    await expect(
      files.write(
        "ses_update",
        renderSnapshot({ ...snapshot.persona, prompt: "Changed." }, "Changed rules."),
      ),
    ).rejects.toThrow("Commit unavailable");
    expect(await files.read("ses_update")).toEqual(snapshot);
    expect(await fs.readFile(join(target, "unrelated.txt"), "utf8")).toBe("Keep me.");
    expect(await fs.readdir(join(directory, "sessions"))).toEqual(["ses_update"]);
    await fs.rm(join(target, "AGENTS.md"));
    await expect(files.write("ses_update", snapshot)).rejects.toThrow("Commit unavailable");
    await expect(fs.stat(join(target, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(join(target, ".opencode", "agents", "persona1.md"), "utf8")).toBe(
      snapshot.agent,
    );
  }));

test("preflight read failures never publish part of an update and canonical paths reject unsafe IDs", () =>
  withFiles(async (files, directory) => {
    const target = await files.write("ses_read", snapshot);
    await fs.rm(join(target, "AGENTS.md"));
    await fs.mkdir(join(target, "AGENTS.md"));
    await expect(
      files.write(
        "ses_read",
        renderSnapshot({ ...snapshot.persona, prompt: "Must not leak." }, "New."),
      ),
    ).rejects.toMatchObject({ code: "EISDIR" });
    expect(await fs.readFile(join(target, ".opencode", "agents", "persona1.md"), "utf8")).toBe(
      snapshot.agent,
    );
    expect(sessionDirectory(directory, "ses_read")).toBe(target);
    expect(managedFolder(directory, target)).toBe("ses_read");
    expect(managedFolder(directory, join(directory, "sessions", "not-a-session"))).toBeUndefined();
    expect(managedFolder(directory, directory)).toBeUndefined();
    expect(() => sessionDirectory(directory, "ses_../../escape")).toThrow(/Expected/);
  }));
