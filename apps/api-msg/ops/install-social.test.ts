import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("native social installation pins runtimes, shares the protected environment, and writes a GUI LaunchAgent without starting it", async () => {
  const base = await mkdtemp(join(tmpdir(), "social-install-"));
  const root = join(base, "installed with spaces");
  const bin = join(base, "bin");
  const plist = join(base, "agents/social.plist");
  const realBun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
  const executable = async (name: string, source: string) => {
    await writeFile(join(bin, name), `#!/bin/bash\nset -eu\n${source}\n`);
    await chmod(join(bin, name), 0o700);
  };
  try {
    await mkdir(root);
    await mkdir(bin);
    await writeFile(join(root, "social.js"), "native executor");
    await writeFile(join(root, "api-msg.env"), "TOKEN_MANAGEMENT=PRIVATE_TOKEN\n", { mode: 0o600 });
    await executable(
      "uname",
      'if [[ "${1:-}" == -m ]]; then printf "arm64\\n"; else printf "Darwin\\n"; fi',
    );
    await executable("id", 'printf "501\\n"');
    await executable(
      "bun",
      `if [[ "$1" == --version ]]; then printf '1.4.4\\n'; elif [[ "$1" == add ]]; then
  [[ "$*" == *'--ignore-scripts --exact agent-browser@0.41.0' ]]
  mkdir -p "$3/node_modules/agent-browser/bin"
  cp "$BROWSER_FIXTURE" "$3/node_modules/agent-browser/bin/agent-browser-darwin-arm64"
else exec "$REAL_BUN" "$@"; fi`,
    );
    await executable("browser", "printf 'agent-browser 0.41.0\\n'");
    await executable(
      "plutil",
      'if [[ "$1" == -convert ]]; then cat > "$4"; else [[ -s "$2" ]]; fi',
    );
    await executable("launchctl", "exit 99");
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"]}`,
      REAL_BUN: realBun,
      BROWSER_FIXTURE: join(bin, "browser"),
      SOCIAL_LAUNCH_AGENT: plist,
    };
    const run = () =>
      execFileSync("bash", ["apps/api-msg/ops/install-social.sh", root], { env, encoding: "utf8" });
    expect(run()).toContain("WITHOUT STARTING");
    const contents = await readFile(plist, "utf8");
    expect(JSON.parse(contents)).toMatchObject({
      Label: "im.renai.social",
      ProgramArguments: [
        join(root, "bin/bun"),
        `--env-file=${root}/api-msg.env`,
        join(root, "social.js"),
      ],
      EnvironmentVariables: {
        SOCIAL_HOME: join(root, "social-state"),
        SOCIAL_AGENT_BROWSER: join(root, "bin/agent-browser"),
      },
      RunAtLoad: true,
      KeepAlive: true,
    });
    expect(contents).not.toContain("PRIVATE_TOKEN");
    expect((await stat(join(root, "social-state"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "bin/agent-browser"))).mode & 0o777).toBe(0o700);
    expect(() => run()).toThrow("Command failed");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
