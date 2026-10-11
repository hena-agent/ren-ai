import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { createFileLog, GenerationError } from "./logging.ts";
import type { LogEntry } from "./logging.ts";
import { createAdmin } from "./admin.ts";
import { fixture, generator, request, newToken } from "../test/fixtures.ts";

vi.mock("node:fs", async () => ({
  ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
}));
afterEach(() => vi.restoreAllMocks());

test("a failed real Admin operation is durably searchable by request ID before the error response returns", async () => {
  const root = await mkdtemp(join(tmpdir(), "admin-file-log-"));
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const { store } = await fixture();
    const directory = join(root, "logs");
    const privateIdea = "private log retention test idea";
    const admin = createAdmin(store, "test-password", "", {
      log: createFileLog(directory),
      generator: {
        ...generator,
        character: async () => {
          throw new GenerationError(`provider rejected ${privateIdea}`, {
            code: "UPSTREAM_FAILURE",
            model: "text-model",
            status: 503,
          });
        },
      },
    });
    const token = await newToken(admin);
    const failed = await admin(
      request("/personas", { draft: token, seed: privateIdea, intent: "character" }),
    );
    expect(failed.status).toBe(503);
    const id = failed.headers.get("x-request-id")!;
    expect(await failed.text()).toContain(id);
    const file = join(directory, `admin-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const persisted = await readFile(file, "utf8");
    const relevant = persisted.split("\n").filter((line) => line.includes(id));
    expect(relevant.filter((line) => line.includes('"event":"operation.failed"'))).toHaveLength(1);
    expect(relevant.join("\n")).toContain('"stage":"character.generate"');
    expect(relevant.join("\n")).toContain('"model":"text-model"');
    expect(relevant.join("\n")).toContain('"code":"UPSTREAM_FAILURE"');
    expect(relevant.at(-1)).toContain('"event":"request.completed"');
    for (const secret of [privateIdea, token, "admin:test-password"])
      expect(persisted).not.toContain(secret);
    expect(out).toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daily append retains existing diagnostics across logger recreation", async () => {
  const root = await mkdtemp(join(tmpdir(), "admin-log-days-"));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const first: LogEntry = {
      time: "2026-10-10T23:59:59.000Z",
      service: "admin",
      level: "info",
      event: "before_restart",
    };
    createFileLog(root)(first);
    createFileLog(root)({ ...first, event: "after_restart" });
    createFileLog(root)({ ...first, time: "2026-10-11T00:00:00.000Z", event: "next_day" });
    const original = await readFile(join(root, "admin-2026-10-10.jsonl"), "utf8");
    expect(original).toContain("before_restart");
    expect(original).toContain("after_restart");
    expect(await readFile(join(root, "admin-2026-10-11.jsonl"), "utf8")).toContain("next_day");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a persistence sink failure stays visible on stderr and never replaces the application's response or diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "admin-log-failure-"));
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const { store } = await fixture();
    const admin = createAdmin(store, "test-password", "", { log: createFileLog(root) });
    vi.spyOn(fs, "appendFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("disk offline"), { code: "EIO" });
    });
    const response = await admin(request("/new"));
    expect(response.status).toBe(200);
    const output = err.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain('"event":"logging.persistence_failed"');
    expect(output).toContain('"causeCode":"EIO"');
    expect(output).toContain(response.headers.get("x-request-id"));
    vi.spyOn(fs, "appendFileSync").mockImplementationOnce(() => {
      throw null;
    });
    createFileLog(root)({
      time: "2026-10-10T00:00:00.000Z",
      service: "admin",
      level: "warn",
      event: "standalone",
    });
    expect(err.mock.calls.map(([value]) => String(value)).join("")).toContain(
      '"code":"log_write_failed"',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
