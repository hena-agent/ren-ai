import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../../ops/update.sh");
const sha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const gateway = `gui/${process.getuid?.()}/im.renai.imsg`;
const payload = [
  "imsg.js",
  "verify.js",
  "ren-rustpush",
  "imsg.graph.json",
  "verify.graph.json",
  "artifact.info",
];
const executable = { mode: 0o700 };
const contentsOf = (file: string, version: string) =>
  file === "artifact.info"
    ? `architecture=${execFileSync("uname", ["-m"], { encoding: "utf8" }).trim()}\ntransport=rustpush\n`
    : `${version}\n`;

/** A deployable bundle whose gateway identifies itself by its code; graphs are metadata. */
const bundle = (directory: string, version: string, files = payload, graphs = version) => {
  const name = `bundle-${version}-${graphs}-${files.length}`;
  const contents = join(directory, name);
  mkdirSync(contents);
  for (const file of files)
    writeFileSync(
      join(contents, file),
      contentsOf(file, file.endsWith(".graph.json") ? graphs : version),
      executable,
    );
  const archive = join(directory, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", contents, "."]);
  return archive;
};

/** Whether each step occurs after the previous one. */
const inOrder = (text: string, ...steps: string[]) => {
  let from = 0;
  for (const step of steps) {
    const at = text.indexOf(step, from);
    if (at < 0) return false;
    from = at + step.length;
  }
  return true;
};

const restarts = (commands: string) =>
  commands.match(new RegExp(`^launchctl kickstart -k ${gateway}$`, "gm"))?.length ?? 0;

interface Fake {
  readonly run?: string;
  readonly bundle?: string;
  readonly attested?: boolean;
  /** Gateway versions whose probe passes. */
  readonly healthy?: string;
  /** Instead of `healthy`: only the first N probes pass. */
  readonly passes?: number;
}

/** An installed Messages home with fake gh, launchctl and probe. */
function mac() {
  const directory = mkdtempSync(join(tmpdir(), "imsg-deploy-"));
  const root = join(directory, "home");
  const bin = join(directory, "bin");
  const log = join(directory, "commands");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(bin);
  for (const name of payload) writeFileSync(join(root, name), contentsOf(name, "old"), executable);
  writeFileSync(
    join(root, "bin/bun"),
    `#!/bin/bash
version="$(cat "$(dirname "$0")/../imsg.js")"
printf 'probe %s %s\\n' "$version" "$*" >> "$COMMAND_LOG"
if [[ -n "$FAKE_PASSES" ]]; then
  (( $(grep -c '^probe ' "$COMMAND_LOG") <= FAKE_PASSES )) && exit 0
elif [[ " $FAKE_HEALTHY " == *" $version "* ]]; then
  exit 0
fi
printf 'source context\\nerror: probe refused %s\\n    at stack\\n' "$version" >&2
exit 1
`,
    executable,
  );
  // As built by build-mac.sh; the installer and deploy agent add their files afterwards.
  execFileSync(
    "bash",
    ["-c", "find . -type f ! -name SHA256SUMS -exec shasum -a 256 {} \\; > SHA256SUMS"],
    { cwd: root },
  );
  writeFileSync(join(root, "imsg.env"), "IMSG_TOKEN=messaging\n");
  mkdirSync(join(root, "deploy"));
  writeFileSync(join(root, "deploy/token"), "github_pat_read_only\n");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/bash
set -eu
printf 'gh %s | token=%s config=%s\\n' "$*" "$GH_TOKEN" "$GH_CONFIG_DIR" >> "$COMMAND_LOG"
case "$1 $2" in
  "run list") printf '%s\\n' "$FAKE_RUN" ;;
  "api repos/hena-agent/ren-ai/actions/runs/12345/artifacts") [[ -z "$FAKE_BUNDLE" ]] || echo 77 ;;
  "run download") while [[ "$1" != -D ]]; do shift; done; cp "$FAKE_BUNDLE" "$2/imsg-bundle.tar.gz" ;;
  "attestation verify") [[ "$FAKE_ATTESTED" == 1 ]] ;;
  *) exit 64 ;;
esac
`,
    executable,
  );
  writeFileSync(
    join(bin, "launchctl"),
    `#!/bin/bash\nprintf 'launchctl %s\\n' "$*" >> "$COMMAND_LOG"\n`,
    executable,
  );
  const update = (fake: Fake) =>
    spawnSync("/bin/bash", [script, root], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: directory,
        COMMAND_LOG: log,
        FAKE_RUN: fake.run ?? `12345 ${sha} completed`,
        FAKE_BUNDLE: fake.bundle ?? "",
        FAKE_ATTESTED: fake.attested === false ? "0" : "1",
        FAKE_HEALTHY: fake.healthy ?? "",
        FAKE_PASSES: fake.passes === undefined ? "" : String(fake.passes),
        DEPLOY_PROBE_ATTEMPTS: "2",
        DEPLOY_PROBE_DELAY: "0",
      },
    });
  const commands = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const installed = (name: string) => readFileSync(join(root, name), "utf8");
  const state = (name: string) =>
    existsSync(join(root, "deploy", name))
      ? readFileSync(join(root, "deploy", name), "utf8")
      : null;
  /** What restore's `shasum -a 256 -c SHA256SUMS` checks. */
  const checksums = () =>
    readFileSync(join(root, "SHA256SUMS"), "utf8")
      .trim()
      .split("\n")
      .every((line) => {
        const [digest, path = ""] = line.split("  ");
        return (
          createHash("sha256")
            .update(readFileSync(join(root, path)))
            .digest("hex") === digest
        );
      });
  const leftovers = () =>
    readdirSync(join(root, "deploy")).filter((name) => name.startsWith("staging."));
  return { directory, root, update, commands, installed, state, checksums, leftovers };
}

it("deploys the gateway and Rustpush together, keeping Bun and restorable checksums", () => {
  const fixture = mac();
  const result = fixture.update({ bundle: bundle(fixture.directory, "new"), healthy: "new old" });
  expect(result).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(`Deployed ${sha}`);
  for (const name of payload) expect(fixture.installed(name)).toBe(contentsOf(name, "new"));
  expect(fixture.installed("bin/bun")).toContain("probe");
  expect(fixture.state("deployed")).toBe(`${sha}\n`);
  expect(readFileSync(join(fixture.root, "deploy/previous/imsg.js"), "utf8")).toBe("old\n");
  expect(fixture.checksums()).toBe(true);
  expect(fixture.installed("SHA256SUMS")).toContain("  ./bin/bun\n");
  expect(fixture.leftovers()).toEqual([]);
  const commands = fixture.commands();
  expect(commands).toContain(
    "gh run list -R hena-agent/ren-ai -w ci.yml -b main -e push -L 1 --json databaseId,headSha,status",
  );
  expect(commands).toContain(
    `--signer-workflow github.com/hena-agent/ren-ai/.github/workflows/ci.yml --source-ref refs/heads/main --source-digest ${sha} --deny-self-hosted-runners`,
  );
  expect(commands).toContain(
    `token=github_pat_read_only config=${join(fixture.root, "deploy/gh")}`,
  );
  expect(
    inOrder(
      commands,
      "probe old",
      `launchctl kickstart -k ${gateway}`,
      `probe new --env-file=${join(fixture.root, "imsg.env")}`,
    ),
  ).toBe(true);
  expect(restarts(commands)).toBe(1);
  const first = commands.length;
  expect(
    fixture.update({ bundle: bundle(fixture.directory, "again"), healthy: "new" }).status,
  ).toBe(0);
  expect(fixture.commands().slice(first).trim().split("\n")).toHaveLength(1);
});

it("waits for a running build and skips one without a bundle, so a passing re-run still deploys", () => {
  const fixture = mac();
  const archive = bundle(fixture.directory, "new");
  expect(
    fixture.update({ run: `12345 ${sha} in_progress`, bundle: archive, healthy: "new old" }).status,
  ).toBe(0);
  expect(fixture.update({ run: "", bundle: archive, healthy: "new old" }).status).toBe(0);
  expect(fixture.update({ healthy: "new old" }).status).toBe(0);
  expect(fixture.commands()).not.toMatch(/download|probe|launchctl/);
  expect(fixture.installed("imsg.js")).toBe("old\n");
  expect(fixture.state("deployed")).toBeNull();
  expect(fixture.update({ bundle: archive, healthy: "new old" }).status).toBe(0);
  expect(fixture.installed("imsg.js")).toBe("new\n");
});

it("refuses an unattested or incomplete bundle before replacing anything", () => {
  const fixture = mac();
  const unattested = fixture.update({
    bundle: bundle(fixture.directory, "forged"),
    attested: false,
    healthy: "forged old",
  });
  expect(unattested.status).not.toBe(0);
  const incomplete = fixture.update({
    bundle: bundle(fixture.directory, "partial", payload.slice(0, 2)),
    healthy: "partial old",
  });
  expect(incomplete.status).not.toBe(0);
  for (const name of payload) expect(fixture.installed(name)).toBe(contentsOf(name, "old"));
  expect(fixture.commands()).not.toMatch(/probe|launchctl/);
  for (const marker of ["deployed", "rejected", "deferred"])
    expect(fixture.state(marker)).toBeNull();
  expect(fixture.checksums()).toBe(true);
  expect(fixture.leftovers()).toEqual([]);
});

it("installs a bundle whose code is unchanged without probing or restarting the gateway", () => {
  const fixture = mac();
  const result = fixture.update({ bundle: bundle(fixture.directory, "old", payload, "rebuilt") });
  expect(result).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(`${sha} leaves the gateway's code unchanged`);
  expect(fixture.installed("imsg.js")).toBe("old\n");
  expect(fixture.installed("imsg.graph.json")).toBe("rebuilt\n");
  expect(fixture.checksums()).toBe(true);
  expect(fixture.state("deployed")).toBe(`${sha}\n`);
  expect(fixture.commands()).not.toMatch(/probe|launchctl/);
});

it("rolls back a gateway that fails its probe and never retries that commit", () => {
  const fixture = mac();
  const archive = bundle(fixture.directory, "broken");
  const result = fixture.update({ bundle: archive, healthy: "old" });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("Probe failed: error: probe refused broken");
  expect(result.stdout).toContain(`Rolled back ${sha}: its gateway failed the probe`);
  for (const name of payload) expect(fixture.installed(name)).toBe(contentsOf(name, "old"));
  expect(fixture.checksums()).toBe(true);
  expect(fixture.state("rejected")).toBe(`${sha}\n`);
  expect(fixture.state("deployed")).toBeNull();
  expect(restarts(fixture.commands())).toBe(2);
  const first = fixture.commands().length;
  expect(fixture.update({ bundle: archive, healthy: "old" }).status).toBe(0);
  expect(fixture.commands().slice(first)).not.toMatch(/download|probe|launchctl/);
});

it("tries a commit once while the Mac fails the probe, then waits without restarts until it recovers", () => {
  const fixture = mac();
  const archive = bundle(fixture.directory, "new");
  const result = fixture.update({ bundle: archive });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain(
    `The running gateway fails the probe (error: probe refused old); trying ${sha} once`,
  );
  expect(result.stdout).toContain("the Mac fails the probe with either bundle");
  expect(fixture.installed("imsg.js")).toBe("old\n");
  expect(fixture.checksums()).toBe(true);
  expect(fixture.state("deferred")).toBe(`${sha}\n`);
  expect(fixture.state("rejected")).toBeNull();
  expect(restarts(fixture.commands())).toBe(2);
  // The old gateway already failed, so nothing probes it again after the rollback.
  expect(fixture.commands().match(/^probe /gm)).toHaveLength(3);
  const first = fixture.commands().length;
  expect(fixture.update({ bundle: archive })).toMatchObject({ status: 0, stdout: "" });
  expect(fixture.commands().slice(first)).not.toMatch(/download|launchctl/);
  expect(fixture.update({ bundle: archive, healthy: "new old" }).status).toBe(0);
  expect(fixture.installed("imsg.js")).toBe("new\n");
  expect(fixture.state("deployed")).toBe(`${sha}\n`);
  expect(fixture.state("deferred")).toBeNull();
});

it("deploys a commit that fixes a gateway failing its probe", () => {
  const fixture = mac();
  const result = fixture.update({ bundle: bundle(fixture.directory, "fixed"), healthy: "fixed" });
  expect(result).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(`trying ${sha} once`);
  expect(fixture.installed("imsg.js")).toBe("fixed\n");
  expect(fixture.state("deployed")).toBe(`${sha}\n`);
});

it("defers rather than rejects a commit when the Mac starts failing the probe mid-deploy", () => {
  const fixture = mac();
  const result = fixture.update({ bundle: bundle(fixture.directory, "new"), passes: 1 });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("the Mac fails the probe with either bundle");
  expect(fixture.installed("imsg.js")).toBe("old\n");
  expect(fixture.state("deferred")).toBe(`${sha}\n`);
  expect(fixture.state("rejected")).toBeNull();
});
