import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

function deployment() {
  const directory = mkdtempSync(join(tmpdir(), "fleet-provisioning-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const volumes = join(directory, "isolated volumes");
  for (const name of ["mysql", "redis", "fleet"])
    mkdirSync(join(volumes, name), { recursive: true });
  for (const name of ["setup.sh", "fleet-data.sh", "compose.yaml"]) {
    copyFileSync(resolve(import.meta.dirname, "../../ops/mdm", name), join(directory, name));
  }
  const log = join(directory, "commands");
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == *"run --rm -T --no-deps snapshot"* ]]; then
  [[ "\${FAIL_SNAPSHOT:-0}" != 1 ]] || exit 9
  # Map container mount paths at the external utility boundary only.
  # The production archive commands and restore guard execute unchanged.
  mounted_command() {
    local executable="$1" argument
    shift
    local arguments=()
    for argument in "$@"; do
      case "$argument" in
        /snapshot*) arguments+=("$SNAPSHOT_ROOT\${argument#/snapshot}") ;;
        /backup*) arguments+=("$FLEET_BACKUP_DIR\${argument#/backup}") ;;
        *) arguments+=("$argument") ;;
      esac
    done
    "$executable" "\${arguments[@]}"
  }
  ls() { mounted_command /bin/ls "$@"; }
  tar() { mounted_command /usr/bin/tar "$@"; }
  export -f mounted_command ls tar
  while [[ "$1" != snapshot ]]; do shift; done
  shift
  if [[ "$1" == sh ]]; then shift; bash "$@"; else "$@"; fi
fi
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env["PATH"]}`,
    COMMAND_LOG: log,
    SNAPSHOT_ROOT: volumes,
  };
  return { directory, env, log, volumes };
}

it("sets up Fleet once without rotating existing private keys or exposing secrets", () => {
  const fixture = deployment();
  const script = join(fixture.directory, "setup.sh");
  const first = execFileSync("bash", [script], { env: fixture.env, encoding: "utf8" });
  const file = join(fixture.directory, ".env");
  const configuration = readFileSync(file, "utf8");
  expect(configuration).toMatch(/MYSQL_PASSWORD=[a-f0-9]{64}\n/);
  expect(configuration).toMatch(/MYSQL_ROOT_PASSWORD=[a-f0-9]{64}\n/);
  expect(configuration).toMatch(/FLEET_SERVER_PRIVATE_KEY=[A-Za-z0-9+/]{43}=\n/);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  execFileSync("bash", [script], { env: fixture.env });
  expect(readFileSync(file, "utf8")).toBe(configuration);
  expect(first).not.toContain(configuration);
  expect(readFileSync(fixture.log, "utf8")).toBe(
    "compose up -d --wait mysql redis fleet\ncompose up -d --wait mysql redis fleet\n",
  );
});

it("does not write an incomplete secret file or start Fleet when secret generation fails", () => {
  const fixture = deployment();
  writeFileSync(join(fixture.directory, "bin/openssl"), "#!/usr/bin/env bash\nexit 7\n", {
    mode: 0o700,
  });
  const result = spawnSync("bash", [join(fixture.directory, "setup.sh")], { env: fixture.env });
  expect(result.status).toBe(7);
  expect(existsSync(join(fixture.directory, ".env"))).toBe(false);
  expect(existsSync(fixture.log)).toBe(false);
});

it("exports a cold portable snapshot including encryption keys then restarts Fleet", () => {
  const fixture = deployment();
  writeFileSync(join(fixture.directory, ".env"), "FLEET_SERVER_PRIVATE_KEY=private\n");
  const backup = join(fixture.directory, "backup with spaces");
  execFileSync("bash", [join(fixture.directory, "fleet-data.sh"), "export", backup], {
    env: fixture.env,
  });
  expect(readFileSync(join(backup, "setup.env"), "utf8")).toBe(
    "FLEET_SERVER_PRIVATE_KEY=private\n",
  );
  expect(statSync(join(backup, "fleet-volumes.tgz")).size).toBeGreaterThan(0);
  expect(statSync(backup).mode & 0o777).toBe(0o700);
  expect(statSync(join(backup, "setup.env")).mode & 0o777).toBe(0o600);
  const commands = readFileSync(fixture.log, "utf8");
  expect(commands).toContain("compose stop fleet mysql redis\n");
  expect(commands).toMatch(/compose up -d --wait mysql redis fleet\n$/);
});

it("restores the exact encryption keys into a fresh deployment only after checksum and human approval", () => {
  const original = deployment();
  const secret = "FLEET_SERVER_PRIVATE_KEY=original\nFLEET_API_TOKEN=original-token\n";
  writeFileSync(join(original.directory, ".env"), secret);
  for (const volume of ["mysql", "redis", "fleet"])
    writeFileSync(join(original.volumes, volume, ".state"), `retained ${volume}`);
  const backup = join(original.directory, "snapshot");
  execFileSync("bash", [join(original.directory, "fleet-data.sh"), "export", backup], {
    env: original.env,
  });
  const replacement = deployment();
  const result = spawnSync(
    "bash",
    [join(replacement.directory, "fleet-data.sh"), "restore", backup],
    { env: replacement.env, input: "RESTORE\n", encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  expect(readFileSync(join(replacement.directory, ".env"), "utf8")).toBe(secret);
  expect(result.stdout).not.toContain("original-token");
  for (const volume of ["mysql", "redis", "fleet"])
    expect(readFileSync(join(replacement.volumes, volume, ".state"), "utf8")).toBe(
      `retained ${volume}`,
    );
  expect(readFileSync(replacement.log, "utf8")).toMatch(
    /compose up -d --wait mysql redis fleet\n$/,
  );
});

it.each(["mysql", "redis", "fleet"])(
  "refuses a nonempty %s destination without overwriting any volume data",
  (occupied) => {
    const original = deployment();
    writeFileSync(join(original.directory, ".env"), "key=exported\n");
    for (const volume of ["mysql", "redis", "fleet"])
      writeFileSync(join(original.volumes, volume, ".state"), `exported ${volume}`);
    const backup = join(original.directory, "backup");
    execFileSync("bash", [join(original.directory, "fleet-data.sh"), "export", backup], {
      env: original.env,
    });
    const replacement = deployment();
    const existing = join(replacement.volumes, occupied, ".state");
    writeFileSync(existing, "existing destination data");
    const result = spawnSync(
      "bash",
      [join(replacement.directory, "fleet-data.sh"), "restore", backup],
      { env: replacement.env, input: "RESTORE\n", encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Nonempty volume: ${occupied}`);
    expect(readFileSync(existing, "utf8")).toBe("existing destination data");
    for (const volume of ["mysql", "redis", "fleet"].filter((name) => name !== occupied))
      expect(existsSync(join(replacement.volumes, volume, ".state"))).toBe(false);
    expect(readFileSync(replacement.log, "utf8")).not.toContain("compose up");
  },
);

it("restarts the stopped Fleet stack if snapshot creation fails", () => {
  const fixture = deployment();
  writeFileSync(join(fixture.directory, ".env"), "key=secret\n");
  const result = spawnSync(
    "bash",
    [join(fixture.directory, "fleet-data.sh"), "export", join(fixture.directory, "snapshot")],
    { env: { ...fixture.env, FAIL_SNAPSHOT: "1" } },
  );
  expect(result.status).toBe(9);
  expect(readFileSync(fixture.log, "utf8")).toMatch(/compose up -d --wait mysql redis fleet\n$/);
});

it("refuses to overwrite deployment credentials or existing snapshots", () => {
  const fixture = deployment();
  const file = join(fixture.directory, ".env");
  writeFileSync(file, "key=existing\n");
  const script = join(fixture.directory, "fleet-data.sh");
  const backup = join(fixture.directory, "exists");
  mkdirSync(backup);
  for (const action of ["restore", "export"]) {
    const result = spawnSync("bash", [script, action, backup], {
      env: fixture.env,
      input: "RESTORE\n",
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(file, "utf8")).toBe("key=existing\n");
  }
  expect(existsSync(fixture.log)).toBe(false);
});

it("does not restore a corrupt backup", () => {
  const fixture = deployment();
  const backup = join(fixture.directory, "corrupt");
  mkdirSync(backup);
  writeFileSync(join(backup, "SHA256SUMS"), `${"0".repeat(64)}  fleet-volumes.tgz\n`);
  writeFileSync(join(backup, "fleet-volumes.tgz"), "corrupted");
  const result = spawnSync("bash", [join(fixture.directory, "fleet-data.sh"), "restore", backup], {
    env: fixture.env,
    input: "RESTORE\n",
  });
  expect(result.status).not.toBe(0);
  expect(existsSync(join(fixture.directory, ".env"))).toBe(false);
  expect(existsSync(fixture.log)).toBe(false);
});

it("keeps the attended wizard library identical and syntax-checks without executing the wizard", () => {
  const template = readFileSync(
    resolve(import.meta.dirname, "../../../../.agents/skills/wizard/template.sh"),
    "utf8",
  );
  const wizard = resolve(import.meta.dirname, "../../ops/mdm/attended-setup.sh");
  const contents = readFileSync(wizard, "utf8");
  expect(contents.split("# STAGES:")[0]).toBe(template.split("# STAGES:")[0]);
  expect(contents).toContain("TOTAL_STAGES=4");
  expect(contents.match(/^stage /gm)).toHaveLength(4);
  execFileSync("bash", ["-n", wizard]);
});
