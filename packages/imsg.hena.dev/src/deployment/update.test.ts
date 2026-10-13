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
const payload = [
  "imsg.js",
  "verify.js",
  "messages-ui.applescript",
  "imsg.graph.json",
  "verify.graph.json",
];
const executable = { mode: 0o700 };

/** A deployable bundle whose gateway identifies itself by the content of imsg.js. */
const bundle = (directory: string, version: string, files = payload) => {
  const contents = join(directory, `bundle-${version}`);
  mkdirSync(contents);
  for (const name of files) writeFileSync(join(contents, name), `${version}\n`);
  const archive = join(directory, `bundle-${version}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", contents, "."]);
  return archive;
};

/** An installed Messages home with fake gh, launchctl and a probe that passes for `healthy`. */
function mac() {
  const directory = mkdtempSync(join(tmpdir(), "imsg-deploy-"));
  const root = join(directory, "home");
  const bin = join(directory, "bin");
  const log = join(directory, "commands");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(bin);
  for (const name of payload) writeFileSync(join(root, name), "old\n");
  writeFileSync(
    join(root, "bin/bun"),
    `#!/bin/bash
version="$(cat "$(dirname "$0")/../imsg.js")"
printf 'probe %s %s\\n' "$version" "$*" >> "$COMMAND_LOG"
[[ " $FAKE_HEALTHY " == *" $version "* ]] || { echo "probe refused $version" >&2; exit 1; }
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
  const update = (fake: { run?: string; bundle?: string; attested?: boolean; healthy: string }) =>
    spawnSync("/bin/bash", [script, root], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: directory,
        COMMAND_LOG: log,
        FAKE_RUN: fake.run ?? `12345 ${sha} completed`,
        FAKE_BUNDLE: fake.bundle ?? "",
        FAKE_ATTESTED: fake.attested === false ? "0" : "1",
        FAKE_HEALTHY: fake.healthy,
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

const gateway = `launchctl kickstart -k gui/${process.getuid?.()}/dev.hena.ren-ai-imsg`;

it("deploys an attested main bundle once, keeping the binaries and a restorable checksum list", () => {
  const fixture = mac();
  const result = fixture.update({ bundle: bundle(fixture.directory, "new"), healthy: "new old" });
  expect(result).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(`Deployed ${sha}`);
  for (const name of payload) expect(fixture.installed(name)).toBe("new\n");
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
  expect(commands).toContain(`${gateway}\nprobe new --env-file=${join(fixture.root, "imsg.env")}`);
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
    fixture.update({ run: `12345 ${sha} in_progress`, bundle: archive, healthy: "new" }).status,
  ).toBe(0);
  expect(fixture.update({ run: "", bundle: archive, healthy: "new" }).status).toBe(0);
  expect(fixture.update({ healthy: "new" }).status).toBe(0);
  expect(fixture.commands()).not.toMatch(/download|kickstart/);
  expect(fixture.installed("imsg.js")).toBe("old\n");
  expect(fixture.state("deployed")).toBeNull();
  expect(fixture.update({ bundle: archive, healthy: "new" }).status).toBe(0);
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
  expect(incomplete.stdout).toContain("lacks messages-ui.applescript");
  for (const name of payload) expect(fixture.installed(name)).toBe("old\n");
  expect(fixture.commands()).not.toContain("kickstart");
  expect(fixture.state("deployed")).toBeNull();
  expect(fixture.state("rejected")).toBeNull();
  expect(fixture.checksums()).toBe(true);
  expect(fixture.leftovers()).toEqual([]);
});

it("rolls back a gateway that fails its probe and never retries that commit", () => {
  const fixture = mac();
  const archive = bundle(fixture.directory, "broken");
  const result = fixture.update({ bundle: archive, healthy: "old" });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("Probe failed: probe refused broken");
  expect(result.stdout).toContain(`Rolled back ${sha}: its gateway failed the probe`);
  for (const name of payload) expect(fixture.installed(name)).toBe("old\n");
  expect(fixture.checksums()).toBe(true);
  expect(fixture.state("rejected")).toBe(`${sha}\n`);
  expect(fixture.state("deployed")).toBeNull();
  expect(fixture.commands().split(gateway)).toHaveLength(3);
  const first = fixture.commands().length;
  expect(fixture.update({ bundle: archive, healthy: "old" }).status).toBe(0);
  expect(fixture.commands().slice(first)).not.toMatch(/download|kickstart/);
});

it("keeps retrying a commit when the previous gateway fails its probe too", () => {
  const fixture = mac();
  const archive = bundle(fixture.directory, "new");
  const result = fixture.update({ bundle: archive, healthy: "" });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("previous gateway fails the probe too");
  expect(fixture.installed("imsg.js")).toBe("old\n");
  expect(fixture.state("rejected")).toBeNull();
  expect(fixture.update({ bundle: archive, healthy: "new" }).status).toBe(0);
  expect(fixture.installed("imsg.js")).toBe("new\n");
  expect(fixture.state("deployed")).toBe(`${sha}\n`);
});
