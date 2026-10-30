import { mkdir } from "node:fs/promises";
const revision = process.env.GITHUB_SHA ?? "development";
if (revision !== "development" && !/^[a-f0-9]{40}$/.test(revision))
  throw new Error("Invalid artifact revision");
await mkdir(new URL("../dist", import.meta.url), { recursive: true });
const result = await Bun.build({
  entrypoints: [new URL("./entry.mjs", import.meta.url).pathname],
  outdir: new URL("../dist", import.meta.url).pathname,
  target: "bun",
  define: { BUILD_REVISION: JSON.stringify(revision) },
});
if (!result.success) throw new AggregateError(result.logs, "Social executor build failed");
