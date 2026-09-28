import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import type { HostOptions } from "./host.ts";

/** Set the process environment before any OpenCode module is imported. */
export const isolatedHost = (root: string, options: HostOptions) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = { ...process.env };
      for (const key of Object.keys(process.env)) delete process.env[key];
      process.env["PATH"] = previous["PATH"];
      process.env["HOME"] = root;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, previous);
      }),
  ).pipe(
    Effect.flatMap(() =>
      Effect.tryPromise(async () => {
        for (const name of ["CONFIG", "DATA", "STATE", "CACHE"]) {
          const directory = join(root, name.toLowerCase());
          await mkdir(directory, { recursive: true });
          process.env[`XDG_${name}_HOME`] = directory;
        }
        await mkdir(options.configDirectory, { recursive: true });
        const { createHost } = await import("./host.ts");
        return createHost;
      }),
    ),
    Effect.flatMap((createHost) => createHost(options)),
  );
