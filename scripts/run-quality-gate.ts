import { spawnSync } from "node:child_process";
import process from "node:process";
import exceptions from "../quality-exceptions.json" with { type: "json" };
import duplicationConfig from "../.jscpd.json" with { type: "json" };

const [gate] = process.argv.slice(2);
const command =
  gate === "lint"
    ? [
        "oxlint",
        "--type-aware",
        "--report-unused-disable-directives",
        ...exceptions.lint.flatMap(({ path }) => ["--ignore-pattern", path]),
      ]
    : gate === "duplication"
      ? [
          "jscpd",
          ...(exceptions.duplication.length > 0
            ? [
                "--ignore",
                [
                  ...duplicationConfig.ignore,
                  ...exceptions.duplication.map(({ path }) => path),
                ].join(","),
              ]
            : []),
        ]
      : null;

if (command === null) {
  throw new Error(`Unknown quality gate: ${gate}`);
}

const [binary, ...args] = command;
const result = spawnSync(binary ?? "", args, { stdio: "inherit" });
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
