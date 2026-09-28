# ren-ai

An iMessage service for conversations with fictional personas. This Bun and Turborepo monorepo currently includes a local Persona Lab for testing characters and their decision engine.

The premise is that when agents write most of the code, review does not scale but gates do.

## Quick start

```sh
bun install
```

Add `GEMINI_API_KEY` and `AI_GATEWAY_API_KEY` to `apps/persona-lab/.env` (see `.env.example`), then start the lab from the repo root:

```sh
bun run dev
```

Open http://127.0.0.1:3000. Each conversation gets a shareable `/personas/<persona>/sessions/<session>` URL. During development, Vite updates the UI automatically and Bun restarts the API when its source changes. Run the quality gates with:

```sh
bun run ci
```

## Layout

```
apps/persona-lab/       Local web lab for experimenting with personas.
packages/persona-engine/ Persona state and transition rules.
apps/cli/               Duration CLI and quality-gate example.
packages/duration/      Duration parser and trust-boundary example.
scripts/                Repo tooling: exceptions report and gate verification.
quality-exceptions.json  The only place file-level gate exceptions may live.
```

## The gates

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
| Surviving mutants     | 0              | `bun run mutate`       |

`bun run verify-gates` proves the gates actually reject bad code. It plants a deliberate violation for each gate, runs the real gate, and asserts it is rejected **and named the expected rule** — an exit code alone would pass if the gate had failed for an unrelated reason. It also asserts the Stryker patch is still applied, since that is the mutation gate’s real failure mode. A gate that has silently stopped enforcing anything is the failure mode this repo is designed around.

## Design decisions worth knowing

- **bun installs and runs scripts; Node runs tests.** Vitest treats bun as a package manager only, and the v8 coverage provider does not work on the bun runtime.
- **Libraries have no build step.** Packages export TypeScript source directly. Persona Lab builds its browser UI with Vite when starting; the libraries remain Just-in-Time. A compiled library that has not been built makes type-aware lint and knip exit 0 while enforcing nothing — a silent false pass.
- **Exact version pins, no ranges.** oxfmt is pre-1.0 with no semver protection on formatting output, and `oxlint-tsgolint` is hard-pinned to a TypeScript patch release.
- **bun's default isolated linker is kept.** It turns an undeclared dependency into an immediate failure instead of a latent bug.
- **`globalStore = true` in `bunfig.toml`.** Packages are symlinked from one machine-wide store, so a clone's `node_modules` is ~200KB instead of ~240MB. The cost is that tools resolving plugins by package name from their _own_ location break, since the store is not a parent of the project — `stryker.config.js` references its runner by path for exactly this reason.

## Known patch

`@stryker-mutator/vitest-runner@10.0.0` is patched via `bun patch` (see `patches/`).

Vitest 5 changed `testNamePattern` to match against a `" > "`-joined test name; the Stryker runner still joins with a single space, so every test nested in a `describe` is skipped and every mutant is reported as survived. Upstream: [stryker-js#6210](https://github.com/stryker-mutator/stryker-js/issues/6210).

The patch is pinned to exactly `10.0.0`. If Renovate bumps the runner, `patchedDependencies` stops matching and bun applies nothing — but it **fails closed**: unpatched, the score collapses to 3.33% and `thresholds.break: 100` reds the build. Remove the patch when the fix ships upstream.
