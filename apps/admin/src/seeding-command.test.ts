import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedingCommand } from "./seeding-command.ts";
import { seedManifest } from "../test/seeding.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function scriptedDuckDB(root: string) {
  await writeFile(
    join(root, "duckdb"),
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(root, "query.json"))}, JSON.stringify(process.argv));process.stdout.write(${JSON.stringify(JSON.stringify(seedManifest().seeds.map((seed) => seed.source)))});`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${root}:${process.env["PATH"]}`);
}

test("the local command writes a pinned balanced manifest and uploads it without confirming payment", async () => {
  const root = await mkdtemp(join(tmpdir(), "seeding-command-"));
  const output = join(root, "manifest.json");
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ names: [], records: [], next: "seeds:" }))
    .mockResolvedValueOnce(Response.json({ names: [], records: [] }))
    .mockResolvedValueOnce(
      new Response(null, { status: 303, headers: { location: "/seeding/test-run" } }),
    );
  vi.stubGlobal("fetch", http);
  try {
    await scriptedDuckDB(root);
    const result = await seedingCommand(
      [
        "--count",
        "4",
        "--revision",
        "a".repeat(40),
        "--output",
        output,
        "--admin",
        "http://localhost:3729",
      ],
      { ADMIN_PASSWORD: "secret" },
    );
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
      dataset: "nvidia/Nemotron-Personas-Korea",
      revision: "a".repeat(40),
    });
    expect(result).toContain("http://localhost:3729/seeding/test-run");
    expect(http).toHaveBeenCalledTimes(3);
    expect(new Request(...http.mock.calls[1]!).url).toContain("cursor=seeds%3A");
    expect(await new Request(...http.mock.calls[2]!).text()).not.toContain('"confirm"');
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});

test("the command runs the pinned DuckDB scan and preserves its manifest when the upload fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "seeding-scan-"));
  const output = join(root, "manifest.json");
  const query = join(root, "query.json");
  await scriptedDuckDB(root);
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ names: [], records: [] }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", http);
  try {
    await expect(
      seedingCommand(
        [
          "--count",
          "4",
          "--revision",
          "a".repeat(40),
          "--output",
          output,
          "--admin",
          "https://admin.example",
        ],
        { ADMIN_PASSWORD: "secret" },
      ),
    ).rejects.toThrow("Manifest saved; upload failed: HTTP 503");
    expect(await readFile(query, "utf8")).toContain(`Nemotron-Personas-Korea@${"a".repeat(40)}`);
    expect(await readFile(output, "utf8")).toContain("김하나");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the command rejects invalid options and unsafe origins before exposing credentials", async () => {
  const http = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", http);
  const valid = ["--revision", "a".repeat(40), "--output", "never-created.json"];
  await expect(seedingCommand([], {})).rejects.toThrow("Use --revision");
  await expect(
    seedingCommand([...valid, "--admin", "https://admin.example", "--count", "3"], {
      ADMIN_PASSWORD: "secret",
    }),
  ).rejects.toThrow("Use --revision");
  for (const origin of [
    "http://example.com",
    "ftp://localhost",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com/?query=1",
    "https://example.com/#hash",
  ])
    await expect(
      seedingCommand([...valid, "--admin", origin], { ADMIN_PASSWORD: "secret" }),
    ).rejects.toThrow("Admin must be");
  expect(http).not.toHaveBeenCalled();
  http.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(
    seedingCommand([...valid, "--admin", "http://127.0.0.1:3729"], { ADMIN_PASSWORD: "secret" }),
  ).rejects.toThrow("HTTP 401");
});
