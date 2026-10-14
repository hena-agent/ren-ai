import process from "node:process";

export function catalogLog(
  entry: { level: "info" | "warn" | "error"; event: string } & Record<string, string | number>,
) {
  const output = entry.level === "info" ? process.stdout : process.stderr;
  output.write(`${JSON.stringify(entry)}\n`);
}
