import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { selectSeeds } from "./seed-selection.ts";

const exclusions = Schema.Struct({
  names: Schema.Array(Schema.String),
  records: Schema.Array(Schema.String),
  next: Schema.optionalKey(Schema.String),
});

function adminOrigin(value: string) {
  const origin = new URL(value);
  if (
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      )) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Admin must be an HTTPS origin (HTTP only on loopback)");
  return origin;
}

export async function seedingCommand(args: readonly string[], env: { ADMIN_PASSWORD?: string }) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      count: { type: "string", default: "20" },
      revision: { type: "string" },
      output: { type: "string" },
      admin: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const count = Number(values.count);
  const revision = values.revision;
  if (
    !revision ||
    !/^[a-f0-9]{40}$/.test(revision) ||
    !values.output ||
    !values.admin ||
    !Number.isInteger(count) ||
    count < 4 ||
    count > 200 ||
    count % 4 ||
    !env.ADMIN_PASSWORD
  )
    throw new Error(
      "Use --revision <40-char hash> --count <4..200, multiple of 4> --output <new file> --admin <origin>, with ADMIN_PASSWORD",
    );
  const origin = adminOrigin(values.admin);
  const headers = {
    authorization: `Basic ${Buffer.from(`admin:${env.ADMIN_PASSWORD}`).toString("base64")}`,
    origin: origin.origin,
  };
  const excluded: { names: string[]; records: string[] } = { names: [], records: [] };
  let cursor: string | undefined;
  do {
    const url = new URL("/seeding/exclusions", origin);
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, { headers, redirect: "error" });
    if (!response.ok) throw new Error(`Cannot read seeding exclusions: HTTP ${response.status}`);
    const page = Schema.decodeUnknownSync(exclusions)(await response.json());
    excluded.names.push(...page.names);
    excluded.records.push(...page.records);
    cursor = page.next;
  } while (cursor);
  const data = (
    await promisify(execFile)(
      "duckdb",
      [
        "-json",
        "-c",
        `LOAD httpfs; SELECT * FROM read_parquet('hf://datasets/nvidia/Nemotron-Personas-Korea@${revision}/data/*.parquet') WHERE sex='여자' AND age BETWEEN 20 AND 39 AND marital_status='미혼' QUALIFY row_number() OVER(PARTITION BY floor((age-20)/5) ORDER BY hash(uuid || '${randomUUID()}')) <= ${count * 20}`,
      ],
      { maxBuffer: 128 * 1024 * 1024, timeout: 300000 },
    )
  ).stdout;
  const manifest = selectSeeds(JSON.parse(data), {
    count,
    revision,
    date: new Date().toISOString().slice(0, 10),
    ...excluded,
  });
  const body = JSON.stringify(manifest, null, 2);
  await writeFile(values.output, body, { flag: "wx", mode: 0o600 });
  const uploaded = await fetch(new URL("/seeding", origin), {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body,
    redirect: "manual",
  });
  const location = uploaded.headers.get("location");
  if (uploaded.status !== 303 || !location?.startsWith("/seeding/"))
    throw new Error(
      `Manifest saved; upload failed: HTTP ${uploaded.status}. Re-upload the same manifest to resume.`,
    );
  return `Manifest saved to ${values.output}. Review and confirm at ${new URL(location, origin)}. No generation was authorized.`;
}
