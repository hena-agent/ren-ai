import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import exceptions from "../quality-exceptions.json" with { type: "json" };

export const mutationPatterns = [
  "{apps,packages}/*/src/**/*.{ts,tsx}",
  "!**/*.test.{ts,tsx}",
  ...[...exceptions.coverage, ...exceptions.mutation].map(({ path }) => `!${path}`),
];

export const mutationFiles = (): string[] =>
  globSync(
    mutationPatterns.filter((pattern) => !pattern.startsWith("!")),
    {
      exclude: mutationPatterns.filter((pattern) => pattern.startsWith("!")).map((p) => p.slice(1)),
    },
  ).toSorted();

/** Stable assignment: adding a file does not move existing files between caches. */
export const shardMutations = (shard: string | undefined): string[] => {
  if (shard === undefined) return mutationPatterns;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index > count) {
    throw new Error(`Invalid STRYKER_SHARD: ${shard}; expected index/count (1-based)`);
  }
  const files = mutationFiles().filter(
    (path) => createHash("sha256").update(path).digest().readUInt32BE(0) % count === index - 1,
  );
  if (files.length === 0) throw new Error(`Mutation shard ${shard} is empty`);
  return files;
};

/** Stryker tracks mutant/test sources, but not helpers, config, fixtures or dependencies. */
export const mutationCacheKey = (
  trackedFiles: readonly string[],
  sources: readonly string[],
  root: string,
): string => {
  const mutated = new Set(sources);
  const hash = createHash("sha256");
  for (const path of trackedFiles.toSorted()) {
    // Hash test files too: static mutants do not reliably track changes to their tests.
    if (mutated.has(path) && !path.endsWith(".test-helper.ts") && !path.endsWith(".fake.ts"))
      continue;
    hash
      .update(path)
      .update("\0")
      .update(readFileSync(join(root, path)))
      .update("\0");
  }
  return hash.digest("hex");
};
