import { existsSync, globSync, readFileSync } from "node:fs";
import process from "node:process";
import exceptions from "../quality-exceptions.json" with { type: "json" };

type Entry = { readonly path: string; readonly reason: string; readonly added: string };

const GATES = ["coverage", "mutation", "duplication", "lint"] as const;

const SUPPRESSION =
  /(oxlint-disable\S*|eslint-disable\S*|@ts-nocheck|Stryker disable\S*|v8 ignore\S*)(?<rest>[^\n]*)/gu;

const SOURCE_GLOB = "packages/*/src/**/*.{ts,tsx}";

const fileEntries = (): readonly (readonly [string, Entry])[] =>
  GATES.flatMap((gate) =>
    (exceptions[gate] as readonly Entry[]).map((entry) => [gate, entry] as const),
  );

const inlineSuppressions = (): readonly (readonly [string, string])[] =>
  globSync(SOURCE_GLOB)
    .flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(SUPPRESSION)].map(
        (match) => [file, match.groups?.["rest"] ?? ""] as const,
      ),
    )
    .map(([file, rest]) => [file, rest.replace(/\*\/.*$/u, "").trim()] as const);

const failures: string[] = [];

const entries = fileEntries();
for (const [gate, entry] of entries) {
  if (!existsSync(entry.path)) {
    failures.push(`${gate}: "${entry.path}" no longer exists — delete the exception`);
  }
  if (entry.reason.trim() === "") {
    failures.push(`${gate}: "${entry.path}" has no reason`);
  }
}

const inline = inlineSuppressions();
for (const [file, rest] of inline) {
  if (!/--\s+\S/u.test(rest)) {
    failures.push(`${file}: inline suppression has no "-- reason"`);
  }
}

process.stdout.write(`Quality exceptions: ${entries.length} file, ${inline.length} inline\n`);
for (const [gate, entry] of entries) {
  process.stdout.write(`  [${gate}] ${entry.path} — ${entry.reason}\n`);
}
for (const [file, rest] of inline) {
  process.stdout.write(`  [inline] ${file} ${rest}\n`);
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`ERROR ${failure}\n`);
  }
  process.exitCode = 1;
}
