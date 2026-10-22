import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { personaMemory } from "@ren-ai/plugin-session-folder/memory";
import { restoreMemory } from "../../test/memory.test-helper.ts";
import { withSessionFolders } from "../../test/session-folder.test-helper.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

test("export recovers a pending cross-scope commit before reading either scope or its receipt", () =>
  withSessionFolders((host) =>
    Effect.gen(function* () {
      const session = yield* host.remote.createSession("persona1", undefined, "relation");
      const root = session.location.directory;
      const relation = join(root, "conversations", "relation");
      yield* Effect.promise(() =>
        restoreMemory(root, {
          state: { mood: 50, energy: 50, stress: 50, connection: 50, solitude: 50 },
          additional: {},
          shortTerm: "Life",
          longTerm: [],
          receipts: {},
        }),
      );
      yield* Effect.promise(() =>
        restoreMemory(relation, {
          state: { affection: 20 },
          additional: {},
          shortTerm: "Relationship",
          longTerm: [],
          receipts: {},
        }),
      );
      const memory = personaMemory(root, session.id);
      yield* Effect.promise(() => memory.context());
      const rename = fs.rename;
      const fail = vi
        .spyOn(fs, "rename")
        .mockImplementation((from, to) =>
          String(to) === join(relation, "STATE.md")
            ? Promise.reject(new Error("Interrupted relationship commit"))
            : rename(from, to),
        );
      yield* Effect.addFinalizer(() => Effect.sync(() => fail.mockRestore()));
      yield* Effect.promise(async () => {
        await expect(
          memory.run(
            "update_state",
            {
              scores: { mood: 80, affection: 70 },
              additions: {},
              remove: [],
              reason: "A current event",
            },
            "cross-scope",
            "message",
          ),
        ).rejects.toThrow("Interrupted relationship commit");
      });
      fail.mockRestore();
      const archive = yield* host.rpc.snapshot({ folderID: session.id }, host.location);
      expect(archive.snapshot.runtime?.state?.mood).toBe(80);
      expect(archive.relationships["relation"]?.state?.affection).toBe(70);
      expect(archive.snapshot.runtime?.receipts[`${session.id}:cross-scope`]?.operation).toBe(
        "update_state",
      );
    }),
  ));
