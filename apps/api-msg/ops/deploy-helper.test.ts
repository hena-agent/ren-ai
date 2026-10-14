import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const payload = [
  "api-msg.js",
  "api-msg-verify.js",
  "api-msg.graph.json",
  "api-msg-verify.graph.json",
  "artifact.info",
];

const checksums = async (directory: string) => {
  const lines = await Promise.all(
    payload.map(async (name) => {
      const data = await readFile(join(directory, name));
      return `${createHash("sha256").update(data).digest("hex")}  ${name}`;
    }),
  );
  await writeFile(join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
};

const fixture = async (mode: string) => {
  const base = await mkdtemp(join(tmpdir(), "api-msg-deploy-"));
  const root = join(base, "installed");
  const deploy = join(root, "deploy");
  const bin = join(base, "bin");
  const bundle = join(base, "bundle");
  await Promise.all([
    mkdir(join(root, "bin"), { recursive: true }),
    mkdir(deploy, { recursive: true }),
    mkdir(bin),
    mkdir(bundle),
  ]);
  await writeFile(join(root, "api-msg.env"), "TOKEN_EXECUTOR=not-used-by-probe\n");
  await writeFile(join(deploy, "token"), "github_pat_fixture\n");
  await writeFile(join(root, "SHA256SUMS"), "");
  for (const name of payload) await writeFile(join(root, name), `old-${name}`);
  await checksums(root);
  await writeFile(
    join(root, "bin/bun"),
    `#!/bin/bash\ncount_file="$API_MSG_PROBE_COUNT"\ncount=$(cat "$count_file" 2>/dev/null || printf '0')\ncount=$((count + 1))\nprintf '%s' "$count" > "$count_file"\ncase "$API_MSG_PROBE_MODE:$count" in all-fail:*|fail-after-first:2) exit 1;; esac\n`,
  );
  await chmod(join(root, "bin/bun"), 0o700);
  for (const name of payload) {
    const body = name.endsWith(".js") ? `new-${name}` : `new-meta-${name}`;
    await writeFile(join(bundle, name), body);
  }
  await writeFile(join(bundle, "artifact.info"), "format=api-msg-v1\n");
  await checksums(bundle);
  const archive = join(base, "api-msg-bundle.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", bundle, "."]);
  const calls = join(base, "gh-calls.log");
  const launches = join(base, "launchctl.log");
  await writeFile(
    join(bin, "gh"),
    `#!/bin/bash\nif [[ "$1 $2" == 'run list' ]]; then printf '88 cafef00d completed\\n'; exit 0; fi\nif [[ "$1" == api ]]; then printf '123\\n'; exit 0; fi\nif [[ "$1" == attestation ]]; then printf '%s\\n' "$*" >> "$GH_CALL_LOG"; exit 0; fi\nif [[ "$1 $2" == 'run download' ]]; then while (($#)); do if [[ "$1" == -D ]]; then cp "$GH_FIXTURE" "$2/api-msg-bundle.tar.gz"; exit 0; fi; shift; done; fi\nexit 1\n`,
  );
  await writeFile(join(bin, "launchctl"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$LAUNCH_LOG"\n`);
  await Promise.all([chmod(join(bin, "gh"), 0o700), chmod(join(bin, "launchctl"), 0o700)]);
  return {
    base,
    root,
    bin,
    archive,
    calls,
    launches,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      GH_FIXTURE: archive,
      GH_CALL_LOG: calls,
      LAUNCH_LOG: launches,
      API_MSG_PROBE_COUNT: join(base, "probe-count"),
      API_MSG_PROBE_MODE: mode,
      DEPLOY_PROBE_ATTEMPTS: "1",
      DEPLOY_PROBE_DELAY: "0",
    },
  };
};

const runUpdater = (testCase: Awaited<ReturnType<typeof fixture>>) =>
  execFileSync("bash", ["apps/imsg/ops/deploy-helper.sh", "api-msg", testCase.root], {
    cwd: process.cwd(),
    env: testCase.env,
    encoding: "utf8",
  });

test("api-msg updater verifies main provenance, installs payload and restarts only its own agent", async () => {
  const state = await fixture("healthy");
  try {
    runUpdater(state);
    expect(await readFile(join(state.root, "api-msg.js"), "utf8")).toBe("new-api-msg.js");
    expect(await readFile(join(state.root, "deploy/deployed"), "utf8")).toBe("cafef00d\n");
    expect(await readFile(state.calls, "utf8")).toContain(
      "--source-ref refs/heads/main --source-digest cafef00d --deny-self-hosted-runners",
    );
    expect(await readFile(state.launches, "utf8")).toContain("gui/");
    expect(await readFile(state.launches, "utf8")).toContain("im.renai.api-msg");
  } finally {
    await rm(state.base, { recursive: true, force: true });
  }
});

test("metadata-only bundle updates do not restart the executor", async () => {
  const state = await fixture("healthy");
  try {
    for (const name of ["api-msg.js", "api-msg-verify.js"]) {
      await writeFile(join(state.root, name), `new-${name}`);
    }
    await checksums(state.root);
    runUpdater(state);
    await expect(readFile(state.launches, "utf8")).rejects.toThrow("ENOENT");
    expect(await readFile(join(state.root, "deploy/deployed"), "utf8")).toBe("cafef00d\n");
  } finally {
    await rm(state.base, { recursive: true, force: true });
  }
});

test("failed replacement rolls back and marks a rejected artifact when the prior service was healthy", async () => {
  const state = await fixture("fail-after-first");
  try {
    expect(() => runUpdater(state)).toThrow("Command failed");
    expect(await readFile(join(state.root, "api-msg.js"), "utf8")).toBe("old-api-msg.js");
    expect(await readFile(join(state.root, "deploy/rejected"), "utf8")).toBe("cafef00d\n");
    expect((await readFile(state.launches, "utf8")).trim().split("\n")).toHaveLength(2);
  } finally {
    await rm(state.base, { recursive: true, force: true });
  }
});

test("failed old and replacement probes defer the commit until the executor recovers", async () => {
  const state = await fixture("all-fail");
  try {
    expect(() => runUpdater(state)).toThrow("Command failed");
    expect(await readFile(join(state.root, "api-msg.js"), "utf8")).toBe("old-api-msg.js");
    expect(await readFile(join(state.root, "deploy/deferred"), "utf8")).toBe("cafef00d\n");
    expect((await readFile(state.launches, "utf8")).trim().split("\n")).toHaveLength(2);
    expect(runUpdater(state)).toBe("");
    expect((await readFile(state.launches, "utf8")).trim().split("\n")).toHaveLength(2);
  } finally {
    await rm(state.base, { recursive: true, force: true });
  }
});
