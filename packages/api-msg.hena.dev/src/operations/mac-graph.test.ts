import { expect, test } from "vitest";
import { verifyMacGraph } from "./mac-graph.ts";

const graph = (
  path: string,
  imports: Array<{ path: string; external?: boolean }>,
  output: Array<{ path: string }> = [],
) =>
  JSON.stringify({
    inputs: { [path]: { imports } },
    outputs: { "imsg.js": { imports: output } },
  });

test("Mac artifact manifest rejects OpenCode and non-platform externals", () => {
  expect(() =>
    verifyMacGraph(
      graph("gateway.ts", [
        { path: "effect", external: false },
        { path: "node:fs", external: true },
        { path: "bun:sqlite", external: true },
        { path: "gestures.ts" },
      ]),
    ),
  ).not.toThrow();
  expect(() => verifyMacGraph(graph("node_modules/@opencode/client/index.js", []))).toThrow(
    "OpenCode in Mac artifact",
  );
  expect(() =>
    verifyMacGraph(graph("gateway.ts", [{ path: "@opencode/client", external: true }])),
  ).toThrow("OpenCode in Mac artifact");
  expect(() => verifyMacGraph(graph("gateway.ts", [], [{ path: "effect" }]))).toThrow(
    "Unbundled Mac dependency",
  );
  expect(() =>
    verifyMacGraph(
      graph("gateway.ts", [], [{ path: "node:fs" }, { path: "http" }, { path: "bun:sqlite" }]),
    ),
  ).not.toThrow();
  expect(() => verifyMacGraph("{}")).toThrow('Missing key\n  at ["inputs"]');
  expect(() => verifyMacGraph('{"inputs":{"x":{}},"outputs":{}}')).toThrow(
    'Missing key\n  at ["inputs"]["x"]["imports"]',
  );
  expect(() => verifyMacGraph('{"inputs":{"x":{"imports":[{}]}},"outputs":{}}')).toThrow(
    'Missing key\n  at ["inputs"]["x"]["imports"][0]["path"]',
  );
});
