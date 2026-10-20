# AGENTS.md

- Use the official product name defined in `CONTEXT.md` in UI, assets, documentation and responses. For Discovery design changes, read `docs/specs/discovery-design.md`.
- Ask for and receive explicit user approval before creating a Git worktree.
  Use the current working directory unless the user approves another worktree.
- Do not preserve backward compatibility. Remove obsolete paths instead of
  adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current
  requirements. Avoid speculative abstractions, configuration, and
  indirection.
- Grow the system in layers. Start from the smallest version that works end
  to end, and add each new capability on top of a product that already
  works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall
  complexity or improve reliability. Do not reimplement common
  functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own
  implementation or adding packages. Do not assume a library lacks a
  capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap
  that only works for now and is meant to be replaced later.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for this repo (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical triage labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Quality gates

This repo enforces seven gates. They are not advisory. `bun run ci` runs all of them and CI blocks on it.

Before running checks, activate the Node version in `.nvmrc` (`nvm use`) and verify it with `node --version`. Vitest uses Node from `PATH`, even when launched through Bun; Node 22 cannot parse OpenCode's `await using` syntax.

Use focused checks during development. Run `bun run ci` once after implementation and final review; batch any fixes, rerun only affected checks, and report unresolved failures.

Serialize coverage and `verify-gates` runs within one checkout. Wait for other runs to finish: Vitest shares its report directory, and `verify-gates` temporarily plants and deletes source fixtures.

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

Exceptions live in `quality-exceptions.json`.

A sudden burst of `no-unsafe-*` errors means the TypeScript program is misconfigured, **not** that you should add a disable comment.

### Package shape

Libraries are Just-in-Time: `exports` points at `./src/index.ts`, there is no build step, and relative imports use explicit `.ts` extensions. Do not add a `build` script or emit `dist/` in a library — an unbuilt compiled package makes type-aware lint and knip exit 0 while enforcing nothing. Browser applications (`apps/discovery` and Persona Lab's frontend) build JavaScript for browsers; nothing imports their output, and every gate runs on their source.

Changes to the shapes in `packages/onboarding` must keep the Discovery client and Admin working with the API still running: new fields stay optional until the API deploys, and clients continue handling every answer the old API can give.

The Messages Mac deploys itself from `main` on its own schedule (`apps/imsg/ops/README.md`). Changes to `@ren-ai/imsg/protocol` keep the running application working, and the application keeps handling every answer the deployed Mac can give.

## Durable Object storage

- Treat Durable Objects as authoritative state and coordination, not a polling cache. Schedule persisted work when state changes; keep maintenance bounded. See ADR-0019 for the Mac/Cloudflare boundary.
- Budget storage rows read/written separately from requests. Use indexed predicates and SQL limits/keyset cursors before loading recovery batches; verify hot queries with `EXPLAIN QUERY PLAN` against the real schema.
- Persist collection fingerprints and schedules across actor replacement. Reconcile changed accounting metadata, including late measurements, while leaving unchanged history untouched. Keep unchanged Admin checkpoints free of storage transactions and writes.
- Test repeated idle checks, concurrent checkpoints, actor replacement and growing history at the real storage boundary. Preserve durable deduplication, recovery and uncertain-send behavior while reducing access; passing functional tests alone does not establish bounded storage cost.

## Persona authoring

- Seeding runs use the bounded, operator-confirmed workflow in `docs/specs/nemotron-seeding.md`. One explicit run confirmation authorizes its two identity sheets and one photo per style for each seed; subsequent edits and uncertain-call retries retain individual confirmation. Preserve consumed-source receipts after Persona deletion and reuse the image FIFO and publication validators.

- Every image-generation action offers an **optional operator prompt**: identity sheets, gallery photo additions, and individual photo regeneration. An empty prompt uses the normal character, style and reference direction. Submit paid generation only after the operator confirms the image-options dialog.
- Give each actual image its own optional prompt: two photos have two inputs; the initial anime/photo sheets have two. Sheets, photo additions and regeneration share one global Durable Object FIFO and run one at a time. Persist private drafts, task state and submission deduplication across restarts; interrupted paid calls require operator-confirmed retry. Acknowledge queued browser submissions promptly, show per-photo waiting/generating/saving/completed/failed states and apply completed previews immediately. Retrying a failed row creates only that image, preserving completed siblings. Keep operational queue IDs and task state out of persona data and public responses.
- Allow more photo batches for the same persona while photos are running; sheet generation requires that persona's queue to be idle and locks competing work until it finishes. Show running and waiting batches together and preserve an open prompt dialog during polling. Count completed photos plus queued/running additions against each style's six-photo limit. Adopt the latest preview at worker start. Keep source editing, deletion and saving locked until all that persona's queued work finishes.
- Image count defaults to **1** and increases only by operator selection. Every photo addition targets one style within its six-photo capacity, including its first photo; individual regeneration always makes one. Sheets are one per style. Preserve the count for a failed same-target retry; reset a different target to one.
- Keep the optional prompt scoped to its image/action. Preserve it for a failed same-target retry; start a different target with an empty prompt. Keep prompt text in private editing drafts and exclude it from persona files, public API responses and logs.
- Start new personas with independent anime and photo multi-view identity sheets, automatically adopting each completed sheet. Existing personas can create a same-style sheet from a selected owned photo or their description. Every photo generation requires its style's sheet; representative photos are gallery order, not identity references. Store sheets separately from Persona documents and public galleries, outside the six-photo limit. Sheet replacement preserves completed photos, and failed replacement preserves the previous sheet. Use the shared durable FIFO and per-image prompt/confirmation flow for sheets too. See the latest workflow in `docs/specs/persona-discovery-admin.md`.
- Treat every gallery photo equally: no representative/secondary roles, representative selection, promotion or whole-gallery generation. Preserve style-specific order; Discovery displays the first photo first. Every addition and regeneration requires a readable same-style sheet at the server boundary, including queued work and retries. Add, regenerate and delete selected photos while preserving siblings and the sheet. Save name and Markdown edits with existing photos; photo generation is an independent operator choice.
- Generate self-presentation: photos the persona would choose for a dating profile and a first-person introduction they would actually write. Express private emotional darkness only as a subtle undertone. Vary selfies, friend-taken snapshots, travel/full-body and everyday pictures instead of imposing headshot framing or illustrating internal pathology.
- New persona creation defaults to female, with the male option disabled in both the UI and creation boundary. Keep the character and image prompts capable of representing either gender; legacy records without a gender continue using their descriptions.
- When changing authoring or image generation, read the latest workflow section in `docs/specs/persona-discovery-admin.md` for reference, retry and publication behavior.
- Keep native/primary language background in Persona, operator-approved initial proficiency in State, learned expressions in Memory, and proficiency growth in the individual Conversation's State. Never copy Catalog edits into an existing Conversation. Discovery exposes only initial proficiency and does not translate public persona writing; screen locale, consent locale, and preferred conversation language are separate.

## Logging

- At boundaries that turn failures into user responses or background-task results, emit structured diagnostics before handling the failure. Preserve the underlying cause and error code; a generic user-facing message is not a diagnostic.
- Correlate request and operation events with a server-generated request ID. Record the operation, stage, outcome and duration; include relevant persona ID, model, portrait style and upstream HTTP status. Make the request ID available on error responses so operators can find the corresponding logs.
- Use `info` for lifecycle events, `warn` for expected input/conflict failures and `error` for generation, persistence and unexpected failures. Runtime sinks write one JSON event per line to stdout (`info`) or stderr (`warn`/`error`). Reuse the application's logging path; `apps/admin/src/logging.ts` is the Admin implementation.
- Log a failure's diagnostic once per operation, with a completion summary at the request boundary. Observe each parallel task so a sibling failure remains visible after the request has returned.
- Keep credentials, authorization headers, signed drafts, handles, conversation text, private persona descriptions, prompts and image bytes/base64 out of logs. Allowlist provider diagnostic fields, redact echoed secrets/private inputs and bound diagnostic strings. Replace payload-bearing schema/JSON errors with a safe summary and retain stack frames separately.
- Test failure logging through the real request/task boundary: assert correlation, stage/cause metadata and sensitive-data exclusion alongside the existing recovery behavior.

## Service health

- Every HTTP API provides `GET /health` with `service`, `revision` (the full source commit embedded in the running artifact; `development` locally), and `status` (`ready` or `degraded`). Use `@ren-ai/transport/health`; retain the service's authentication boundary and send `Cache-Control: no-store`.
- Return HTTP 200 for ready and 503 for degraded. Report required dependency readiness separately so a live database cannot conceal an unavailable executor. Keep credentials, user data, private paths and upstream payloads out of health responses.
- Deployment checks verify the expected service and exact artifact revision, not just HTTP success. Mac post-restart probes require the running artifact's revision and readiness. Artifact publication alone does not prove Mac installation or tunnel routing.
- Worker CI may verify identity while dependencies are still rolling out: Mac updaters consume completed CI artifacts. Record degraded readiness explicitly and verify it after the Mac update before declaring the end-to-end rollout complete.

## Ports

Assign a stable, uncommon default per local service: **3000–3999 for frontends**, **4000–4999 for backends**, and **5000–5999 for auxiliary services**. A browser-facing full-stack app uses the frontend range; a separate API listener uses the backend range.

Before choosing a default, check existing service configs and local listeners for collisions. Keep ports configurable through per-app environment variables, and update launch commands, frontend proxies, `.env.example`, and documented URLs together. Vite development and preview servers use `strictPort: true` so a busy default is reported rather than silently changed.

Tests that bind real listeners use port `0` for OS allocation. Existing deployed listeners and third-party internal ports follow their deployment contracts; changing them also requires updating the corresponding tunnel/proxy mappings.
