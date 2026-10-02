# ren-ai

An iMessage service for conversations with fictional personas. This Bun and Turborepo monorepo includes the messaging site and server, a local Persona Lab, and a standalone persona engine, with seven quality gates that block CI.

The premise is that when agents write most of the code, review does not scale but gates do.

## Quick start

```sh
bun install
```

Add `GEMINI_API_KEY` and `AI_GATEWAY_API_KEY` to `apps/persona-lab/.env` (see `.env.example`), then start the lab from the repo root:

```sh
bun run --cwd apps/persona-lab dev
```

Open http://127.0.0.1:3617. Each conversation gets a shareable `/personas/<persona>/sessions/<session>` URL; Vite proxies `/api/` to the lab backend on port 4617. Override them with `FRONTEND_PORT` and `BACKEND_PORT` in the lab's `.env`. During development, Vite updates the UI automatically and Bun restarts the API when its source changes. Run the quality gates with:

```sh
bun run ci
```

## Layout

```
apps/persona-lab/     Local simulation app for the standalone persona engine.
packages/persona-engine/  Relationship state engine (not wired into iMessage runtime).
packages/onboarding/   Shared browser-safe Handle rules, locale copy, and Onboarding/Waitlist shapes.
packages/msg.hena.dev/   Prerendered Korean onboarding site, served as static assets.
packages/api-msg.hena.dev/  Mac messaging API, portable application, OpenCode persona plugin, and operator CLI.
scripts/                Repo tooling: exceptions report and gate verification.
quality-exceptions.json  The only place file-level gate exceptions may live.
```

## The gates

For the messaging services, use the [deployment and relocation runbook](packages/api-msg.hena.dev/ops/README.md). The [service boundary decision](docs/adr/0010-separate-the-messages-mac-from-opencode.md) records the Mac/Docker split and the native OpenCode interface at `oc.hena.dev`.

| Gate                  | Threshold      | Command                |
| --------------------- | -------------- | ---------------------- |
| Formatting            | clean          | `bun run format:check` |
| Cyclomatic complexity | < 22           | `bun run lint`         |
| Cognitive complexity  | < 22           | `bun run lint`         |
| Lines per file        | < 500          | `bun run lint`         |
| `any` types           | 0              | `bun run lint`         |
| Types                 | clean          | `bun run typecheck`    |
| Coverage              | 100%, per file | `bun run test`         |
| Dead code             | 0              | `bun run knip`         |
| Duplicated code       | 0              | `bun run dup`          |

`bun run verify-gates` proves the gates actually reject bad code. It plants a deliberate violation for each gate, runs the real gate, and asserts it is rejected **and named the expected rule** — an exit code alone would pass if the gate had failed for an unrelated reason. A gate that has silently stopped enforcing anything is the failure mode this repo is designed around.

### CI execution

`bun run ci` runs every gate locally. GitHub Actions runs `ci:checks` (including the site build) and `verify-gates` in parallel, each in its own checkout. The **Quality gates** check succeeds only when both jobs pass; deployment waits for it. `verify-gates` plants both coverage violations in one suite run and checks that each file has its own threshold failure.

## Design decisions worth knowing

- **bun installs and runs scripts; Node runs tests.** Vitest treats bun as a package manager only, and the v8 coverage provider does not work on the bun runtime.
- **Libraries are Just-in-Time.** They export TypeScript source directly, with no build step. The messaging site and Persona Lab build their browser UIs with Vite; the lab builds when starting. An unbuilt compiled library makes type-aware lint and knip exit 0 while enforcing nothing — a silent false pass.
- **Exact version pins, no ranges.** oxfmt is pre-1.0 with no semver protection on formatting output, and `oxlint-tsgolint` is hard-pinned to a TypeScript patch release.
- **bun's default isolated linker is kept.** It turns an undeclared dependency into an immediate failure instead of a latent bug.
- **`globalStore = true` in `bunfig.toml`.** Packages are symlinked from one machine-wide store, so a clone's `node_modules` is ~200KB instead of ~240MB.
