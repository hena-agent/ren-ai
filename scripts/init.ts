import { spawnSync } from "node:child_process";
import { globSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";

/**
 * Turns a clone of this template into a project of its own.
 *
 * Idempotent: running it twice is harmless. Removes itself once the install
 * succeeds, so a project cannot accidentally re-scope itself later.
 */

const TEMPLATE_SCOPE = "@repo";

const TARGETS = [
  "package.json",
  "README.md",
  "AGENTS.md",
  "{apps,packages}/*/package.json",
  "{apps,packages}/*/src/**/*.ts",
];

const rescope = (scope: string): number => {
  let changed = 0;
  for (const file of TARGETS.flatMap((pattern) => globSync(pattern))) {
    const before = readFileSync(file, "utf8");
    const after = before.replaceAll(`${TEMPLATE_SCOPE}/`, `${scope}/`);
    if (after !== before) {
      writeFileSync(file, after);
      changed += 1;
    }
  }
  return changed;
};

const scope = process.argv[2];

if (scope === undefined || !scope.startsWith("@")) {
  process.stderr.write("usage: bun run init @your-scope\n");
  process.exitCode = 2;
} else {
  const changed = rescope(scope);
  process.stdout.write(`Rescoped ${TEMPLATE_SCOPE} to ${scope} in ${changed} file(s).\n`);

  // Workspace package names are baked into bun.lock. Without this, the very
  // first CI run fails on `bun install --frozen-lockfile`.
  const install = spawnSync("bun", ["install"], { stdio: "inherit", shell: false });

  if (install.status === 0) {
    rmSync("scripts/init.ts", { force: true });
    process.stdout.write("Lockfile refreshed. Commit the result and run `bun run ci`.\n");
  } else {
    process.stderr.write("`bun install` failed; leaving scripts/init.ts in place.\n");
    process.exitCode = 1;
  }
}
