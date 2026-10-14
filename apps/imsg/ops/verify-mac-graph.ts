import { readFile } from "node:fs/promises";
import { verifyMacGraph } from "../src/operations/mac-graph.ts";

for (const path of process.argv.slice(2)) verifyMacGraph(await readFile(path, "utf8"));
