# ren-ai

An iMessage service for conversations with fictional personas. This Bun and Turborepo monorepo includes persona discovery and Admin, the messaging site and server, a local Persona Lab, and a standalone persona engine, with eight quality gates that block CI.

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

## Persona discovery and Admin

Admin creates OpenCode personas from a name and detailed private character description. A brief idea can generate an editable AI character draft. AI creates a public introduction and both portrait styles—LovePlus-inspired anime and near-photorealistic—with preview and retry before saving them together. IDs and runtime instructions are managed internally. Discovery users choose a display style for the whole catalog and can switch it without losing Like / Pass choices. Discovery registers a Handle and liked personas on the server after web consent. This stage ends at waiting registration; invitations, operator selection and delayed first messages are the next implementation unit.

Start Admin with a password:

```sh
ADMIN_PASSWORD='<operator password>' bun run --cwd apps/admin dev
```

Open http://127.0.0.1:3729 and sign in as `admin`. Write a name and detailed description directly, or enter a brief idea to create an editable AI draft. Generate the public introduction and both portrait styles, preview or retry them, then save both with publication enabled. Admin does not choose the visitor's display style. An unfinished character can be saved privately before profile generation. Descriptions stay private; first-message and memory instructions derive from service rules, and the OpenCode prompt incorporates the description.

Admin uses `GEMINI_API_KEY`, or the existing key in `apps/persona-lab/.env` when unset. Its default models are `gemini-3.8-flash` for introductions and `gemini-3.1-flash-image` for 4:5 portraits. Override them with `ADMIN_TEXT_MODEL` / `ADMIN_IMAGE_MODEL`, and the provider's API base with `GEMINI_API_URL`. Keys stay on the server. Admin renders HTML and bundles only its small progress script in memory at startup.

Run the discovery-only local API and frontend in separate terminals:

```sh
TURNSTILE_SECRET=1x0000000000000000000000000000000AA bun run --cwd packages/api-msg.hena.dev dev:discovery
bun run --cwd apps/discovery dev
```

Open http://127.0.0.1:3867 and choose anime or realistic display for the whole catalog. The style is restored across reloads and can be switched while browsing or entering contact details without resetting choices or inputs. Its Vite proxy calls the API on port 4867, including both generated images. The frontend and backend use Cloudflare's public test keys locally. Defaults share Admin's `apps/admin/data/personas` directory and store registrations in `packages/api-msg.hena.dev/data/discovery.sqlite`. Generated portraits live in the persona directory's `images/` subdirectory; include it with the Markdown files in persona backups. Both images referenced by a published persona are served publicly. Legacy single-image personas use their existing image. `PERSONA_DIRECTORY` and `DISCOVERY_DATABASE` override the API's paths. Use `PORT` per process to change its default port and `DISCOVERY_API_URL` to change the frontend proxy target. Vite reports busy ports instead of switching silently.

For public hosting, configure the frontend's `VITE_DISCOVERY_API_URL` and real `VITE_TURNSTILE_SITE_KEY`, and the API's matching `TURNSTILE_SECRET`. The existing messaging API also serves `/discovery/personas` and `/discovery/waitlist`, using its own server database. Its allowed browser origin remains `https://msg.hena.dev`; deployment and domain cutover are tracked in the [MVP spec](docs/specs/persona-discovery-admin.md). See both apps' `.env.example` files for configuration.

Quality checks and mutation tests use Node 24 from `.nvmrc`.

## Layout

```
apps/admin/            Password-protected OpenCode persona editor; server-rendered HTML.
apps/discovery/        Browser persona cards, Like / Pass and waiting registration.
apps/persona-lab/     Local simulation app for the standalone persona engine.
packages/personas/     Shared OpenCode persona loader, validation and file store.
packages/persona-engine/  Relationship state engine (not wired into iMessage runtime).
packages/onboarding/   Shared Handle rules, disclosures, API shapes and browser-only Turnstile.
packages/msg.hena.dev/   Prerendered Korean onboarding site, served as static assets.
packages/api-msg.hena.dev/  iMessage server, embedded OpenCode host, and operator CLI.
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

### CI execution

`bun run ci` runs every gate locally. GitHub Actions runs `ci:checks` (including the messaging site and Discovery builds), `verify-gates`, and four mutation shards in parallel, each in its own checkout. The required **Quality gates** check succeeds only when all jobs pass; deployment waits for it. `verify-gates` plants both coverage violations in one suite run and checks that each file has its own threshold failure.

Mutation testing takes roughly 80–90 minutes unsharded on the hosted runner. `STRYKER_SHARD=1/4 bun run mutate` selects a stable, path-hashed quarter of the existing mutation scope, including its API files. Each runner retains the two-worker memory cap. `bun run verify-ci` checks that the four shards cover the complete scope exactly once and retain the 100% threshold.

PRs use Stryker's incremental reports from a previous successful shard on that PR or its base branch. Main and the weekly schedule always run every mutant and refresh the reports. Cache keys include shard, OS/architecture, Node/Bun versions, and every tracked input except mutated source files (Stryker compares those itself). Tests, shared helpers, and fakes also invalidate the cache, covering Stryker's static-mutant and helper-change limitations. Missing caches run the full shard. Incremental results are a PR optimization; main's full pass also checks interactions between changed and unchanged source files.

## Design decisions worth knowing

- **bun installs and runs scripts; Node runs tests.** Vitest treats bun as a package manager only, and the v8 coverage provider does not work on the bun runtime.
- **Libraries are Just-in-Time.** They export TypeScript source directly, with no build step. The messaging site, Discovery and Persona Lab build their browser UIs with Vite; the lab builds when starting. An unbuilt compiled library makes type-aware lint and knip exit 0 while enforcing nothing — a silent false pass.
- **Exact version pins, no ranges.** oxfmt is pre-1.0 with no semver protection on formatting output, and `oxlint-tsgolint` is hard-pinned to a TypeScript patch release.
- **bun's default isolated linker is kept.** It turns an undeclared dependency into an immediate failure instead of a latent bug.
- **`globalStore = true` in `bunfig.toml`.** Packages are symlinked from one machine-wide store, so a clone's `node_modules` is ~200KB instead of ~240MB. The cost is that tools resolving plugins by package name from their _own_ location break, since the store is not a parent of the project — `stryker.config.js` references its runner by path for exactly this reason.

## Known patch

`@stryker-mutator/vitest-runner@10.0.0` is patched via `bun patch` (see `patches/`).

Vitest 5 changed `testNamePattern` to match against a `" > "`-joined test name; the Stryker runner still joins with a single space, so every test nested in a `describe` is skipped and every mutant is reported as survived. Upstream: [stryker-js#6210](https://github.com/stryker-mutator/stryker-js/issues/6210).

The runner also forces Vitest's thread pool. OpenCode loads `ffi-rs`, whose native addon segfaults on Linux when imported in a worker thread (reproduced with a bare Node worker thread). The patch uses Vitest's fork pool instead, as plain Vitest does, retaining one worker per Stryker runner and all mutation gates. Stryker concurrency is capped at two because seven forked runners exhausted an 8 GB Linux container; the mutation scope and 100% threshold remain unchanged.

The runner also collects Vitest file-level errors. A mutant that breaks module initialization can fail before registering tests; Vitest records that failure on the test file rather than its global error set. The unpatched adapter reported such failures as successful runs with no tests, producing false surviving mutants. The patch reports them as runtime errors, consistent with Stryker's existing error handling; normal assertion failures still kill mutants.

The patch is pinned to exactly `10.0.0`. If Renovate bumps the runner, `patchedDependencies` stops matching and bun applies nothing — but it **fails closed**: `verify-gates` checks all three changes, and without the test-name fix the score collapses to 3.33% and `thresholds.break: 100` reds the build. Remove each hunk when its upstream fix ships.
