import exceptions from "../quality-exceptions.json" with { type: "json" };
import duplicationConfig from "../.jscpd.json" with { type: "json" };

export const qualityCommand = (gate: string): string[] | null =>
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
