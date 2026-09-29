import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  mutationCacheKey,
  mutationFiles,
  mutationPatterns,
  shardMutations,
} from "./mutation-ci.ts";

await test("the four CI shards partition the real mutation scope, including API files", () => {
  const files = mutationFiles();
  const shards = ["1/4", "2/4", "3/4", "4/4"].map(shardMutations);
  assert.ok(files.length > 0);
  assert.deepEqual(shards.flat().toSorted(), files);
  assert.equal(new Set(shards.flat()).size, files.length);
  for (const shard of shards) {
    assert.ok(shard.some((path) => path.startsWith("packages/api-msg.hena.dev/")));
    assert.ok(shard.every((path) => !path.includes(".test.")));
    assert.ok(shard.every((path) => !path.endsWith("server-entry.ts")));
    assert.ok(shard.every((path) => !path.endsWith("operator-entry.ts")));
    assert.ok(shard.every((path) => !path.endsWith("routeTree.gen.ts")));
  }
  assert.ok(files.some((path) => path.startsWith("apps/") && path.endsWith(".ts")));
  assert.ok(files.some((path) => path.startsWith("packages/") && path.endsWith(".tsx")));
  assert.deepEqual(shardMutations(undefined), mutationPatterns);
  assert.deepEqual(shardMutations("1/1"), files);
});

await test("invalid and empty shards fail rather than silently passing", () => {
  for (const shard of ["", "0/4", "5/4", "1/0", "1", "1/4junk", "1.5/4", "1/9007199254740992"]) {
    assert.throws(() => shardMutations(shard), /Invalid STRYKER_SHARD/);
  }
  assert.throws(() => shardMutations("1/9007199254740991"), /is empty/);
});

await test("Stryker's actual configuration uses the same scope and keeps the breaking threshold", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from 'node:assert/strict';
       import config from './stryker.config.js';
       import { shardMutations } from './scripts/mutation-ci.ts';
       assert.deepEqual(config.mutate, shardMutations(process.env.STRYKER_SHARD));
       assert.equal(config.thresholds.break, 100);
       assert.equal(config.concurrency, 2);`,
    ],
    { encoding: "utf8", env: { ...process.env, STRYKER_SHARD: "2/4" } },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

await test("cache fingerprints invalidate all inputs Stryker cannot safely reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "mutation-cache-"));
  const files = [
    "source.ts",
    "source.test.ts",
    "shared.test-helper.ts",
    "messages.fake.ts",
    "bun.lock",
    "config.json",
  ];
  const sources = ["source.ts", "shared.test-helper.ts", "messages.fake.ts"];
  const write = (path: string, content: string): void => writeFileSync(join(root, path), content);
  const key = (): string => mutationCacheKey(files, sources, root);
  try {
    for (const path of files) write(path, "original");
    const original = key();
    assert.equal(mutationCacheKey(files.toReversed(), sources, root), original);
    write("source.ts", "changed source; Stryker detects this");
    assert.equal(key(), original);
    for (const path of files.slice(1)) {
      write(path, "changed");
      assert.notEqual(key(), original, path);
      write(path, "original");
    }
    assert.notEqual(mutationCacheKey(files.slice(0, -1), sources, root), original);
    write("fixture.json", "new input");
    assert.notEqual(mutationCacheKey([...files, "fixture.json"], sources, root), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
