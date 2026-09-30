import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AbsolutePath } from "@opencode/schema";
import { Plugin } from "@opencode/schema/plugin";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { withTransferClient } from "../../test/operations-transfer.test-helper.ts";
import { sessionArchive } from "../opencode/transfer-format.ts";
import { runSessionTransfer } from "./session-transfer.ts";

test("restore refuses unconfirmed migration before reading a file or contacting OpenCode", () =>
  withTransferClient(({ client, root, calls }) =>
    Effect.gen(function* () {
      const input = {
        operation: "restore" as const,
        file: join(root, "does-not-exist.json"),
        directory: root,
      };
      for (const confirmation of [undefined, "no"]) {
        const error = yield* runSessionTransfer(client, { ...input, confirmation }).pipe(
          Effect.flip,
        );
        expect(error.message).toBe(
          "Restore requires CONFIRM_BOOTSTRAP_ONLY=yes; do not restore alongside live intake",
        );
      }
      expect(
        (yield* runSessionTransfer(client, { ...input, confirmation: "yes" }).pipe(Effect.flip))
          .message,
      ).toContain("ENOENT");
      expect(calls).toEqual([]);
    }),
  ));

test("workflow exports and restores native sessions while keeping pending work stopped and other locations intact", () =>
  withTransferClient(({ client, root }) =>
    Effect.gen(function* () {
      const directory = join(root, "source");
      yield* Effect.promise(() => mkdir(directory));
      const source = yield* client.session.create({
        title: "retained reset",
        location: { directory: AbsolutePath.make(directory) },
      });
      const unrelated = yield* client.session.create({
        title: "operator project",
        location: { directory: AbsolutePath.make(root) },
      });
      yield* client.session.prompt({ sessionID: source.id, text: "queued message", resume: false });
      const file = join(root, "archive.json");
      yield* runSessionTransfer(client, {
        operation: "export",
        file,
        directory,
        confirmation: undefined,
      });
      const contents = yield* Effect.promise(() => readFile(file, "utf8"));
      const archive = Schema.decodeUnknownSync(sessionArchive)(contents);
      expect(archive.sessions.map((entry) => entry.info.id)).toEqual([source.id]);
      expect(archive.sessions[0]?.pending).toHaveLength(1);
      expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600);
      yield* client.session.remove({ sessionID: source.id });
      const destination = join(root, "restored");
      yield* Effect.promise(() => mkdir(destination));
      yield* runSessionTransfer(client, {
        operation: "restore",
        file,
        directory: destination,
        confirmation: "yes",
      });
      expect(
        (yield* client.session.list({ directory: AbsolutePath.make(destination) })).data.map(
          (session) => session.id,
        ),
      ).toEqual([source.id]);
      const pending = yield* client.session.inbox.list({ sessionID: source.id });
      expect(pending.map((item) => item.id)).toEqual(
        archive.sessions[0]?.pending.map((item) => item.id),
      );
      expect((yield* client.session.get({ sessionID: unrelated.id })).title).toBe(
        "operator project",
      );
      yield* Effect.promise(() => writeFile(file, "invalid archive"));
      expect(
        (yield* runSessionTransfer(client, {
          operation: "restore",
          file,
          directory: destination,
          confirmation: "yes",
        }).pipe(Effect.flip)).message,
      ).toContain("SchemaError");
    }),
  ));

test("export and plugin inventory create owner-only output exclusively and never overwrite an existing file", () =>
  withTransferClient(({ client, root, calls }) =>
    Effect.gen(function* () {
      const file = join(root, "operator-evidence.json");
      yield* Effect.promise(() => writeFile(file, "keep existing evidence"));
      for (const operation of ["export", "plugins"] as const) {
        const error = yield* runSessionTransfer(client, {
          operation,
          file,
          directory: root,
          confirmation: undefined,
        }).pipe(Effect.flip);
        expect(error.message).toContain("EEXIST");
        expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe("keep existing evidence");
      }
      const inventoryFile = join(root, "plugins.json");
      yield* runSessionTransfer(client, {
        operation: "plugins",
        file: inventoryFile,
        directory: root,
        confirmation: undefined,
      });
      const inventory = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            location: Schema.Struct({ directory: Schema.String }),
            data: Schema.Array(Plugin.Info),
          }),
        ),
      )(yield* Effect.promise(() => readFile(inventoryFile, "utf8")));
      expect(inventory.location.directory).toBe(root);
      expect(inventory.data).toEqual(
        (yield* client.plugin.list({ location: { directory: root } })).data,
      );
      expect((yield* Effect.promise(() => stat(inventoryFile))).mode & 0o777).toBe(0o600);
      expect(calls.some((call) => call.method !== "GET")).toBe(false);
    }),
  ));
