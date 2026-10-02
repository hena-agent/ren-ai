## Agent skills

### Issue tracker

Issues live in GitHub Issues for this repo (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical triage labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Quality gates

This repo enforces seven gates. They are not advisory. `bun run ci` runs all of them and CI blocks on it.

| Gate                  | Threshold      | Enforced by                 |
| --------------------- | -------------- | --------------------------- |
| Cyclomatic complexity | < 22           | oxlint `eslint/complexity`  |
| Cognitive complexity  | < 22           | `oxlint-plugin-complexity`  |
| Lines per file        | < 500          | oxlint `eslint/max-lines`   |
| Test coverage         | 100%, per file | vitest `thresholds.perFile` |
| Dead code             | 0              | knip                        |
| Duplicated code       | 0              | jscpd                       |
| `any` types           | 0              | oxlint `no-explicit-any`    |

### Rules that are easy to get wrong

- **`any` is banned outright.** No exceptions.
- **`unknown` is allowed only at a trust boundary** — a function taking untrusted input (CLI arguments, parsed JSON, environment variables) and narrowing it before anything downstream sees it. It is banned in every other declared parameter, return, or field type. See `packages/onboarding/src/handle.ts` for the intended shape.
- **Coverage is per file, not global.** A global average is trivially gamed by one large well-covered file.
- **Untestable code goes in a thin edge file**, not behind a coverage ignore comment. Keep logic in tested modules and entry shims limited to reading process arguments and starting the application.

### When a gate blocks you

Do **not** delete the test, weaken the type, or inline a duplicate to get green. Those are worse than the violation.

Exceptions live in `quality-exceptions.json`, which is owned by a human via CODEOWNERS. You may propose an entry; you cannot land one. Every entry needs a `reason`. Inline suppressions must carry `-- <reason>` and are reported by `bun run exceptions`.

A sudden burst of `no-unsafe-*` errors means the TypeScript program is misconfigured, **not** that you should add a disable comment.

### Package shape

Libraries are Just-in-Time: `exports` points at `./src/index.ts`, there is no build step, and relative imports use explicit `.ts` extensions. Do not add a `build` script or emit `dist/` in a library — an unbuilt compiled package makes type-aware lint and knip exit 0 while enforcing nothing. The site (`packages/discovery.hena.dev`) is the one package with a build: browsers need JavaScript, nothing imports its output, and every gate runs on its source.

Changes to the shapes in `packages/onboarding` must keep the new site working with the API still running: new fields stay optional until the API deploys, and the site continues handling every answer the old API can give.

## Ports

Assign a stable, uncommon default per local service: **3000–3999 for frontends**, **4000–4999 for backends**, and **5000–5999 for auxiliary services**. A browser-facing full-stack app uses the frontend range; a separate API listener uses the backend range.

Before choosing a default, check existing service configs and local listeners for collisions. Keep ports configurable through per-app environment variables, and update launch commands, frontend proxies, `.env.example`, and documented URLs together. Vite development and preview servers use `strictPort: true` so a busy default is reported rather than silently changed.

Tests that bind real listeners use port `0` for OS allocation. Existing deployed listeners and third-party internal ports follow their deployment contracts; changing them also requires updating the corresponding tunnel/proxy mappings.
