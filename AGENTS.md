## Agent skills

### Issue tracker

Issues live in GitHub Issues for this repo (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical triage labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Quality gates

This repo enforces eight gates. They are not advisory. `bun run ci` runs all of them and CI blocks on it.

| Gate                  | Threshold      | Enforced by                     |
| --------------------- | -------------- | ------------------------------- |
| Cyclomatic complexity | < 22           | oxlint `eslint/complexity`      |
| Cognitive complexity  | < 22           | `oxlint-plugin-complexity`      |
| Lines per file        | < 500          | oxlint `eslint/max-lines`       |
| Test coverage         | 100%, per file | vitest `thresholds.perFile`     |
| Surviving mutants     | 0              | Stryker `thresholds.break: 100` |
| Dead code             | 0              | knip                            |
| Duplicated code       | 0              | jscpd                           |
| `any` types           | 0              | oxlint `no-explicit-any`        |

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

Libraries are Just-in-Time: `exports` points at `./src/index.ts`, there is no build step, and relative imports use explicit `.ts` extensions. Do not add a `build` script or emit `dist/` in a library — an unbuilt compiled package makes type-aware lint and knip exit 0 while enforcing nothing. Browser applications (`packages/msg.hena.dev`, `apps/discovery`, and Persona Lab's frontend) build JavaScript for browsers; nothing imports their output, and every gate runs on their source.

Changes to the shapes in `packages/onboarding` must keep the new site working with the API still running: new fields stay optional until the API deploys, and the site continues handling every answer the old API can give.

## Persona authoring

- Every image-generation action offers an **optional operator prompt**: initial main portraits, independent secondary images, and individual image regeneration. An empty prompt uses the normal character, style and reference direction. Submit paid generation only after the operator confirms the image-options dialog.
- Give each actual image its own optional prompt: two additional photos have two inputs; two per style initially have four. All initial, additional and regeneration images share one process-local FIFO worker and run one at a time. Acknowledge queued browser submissions promptly, show per-photo waiting/generating/saving/completed/failed states and apply completed previews immediately. Retrying a failed row creates only that image, preserving completed siblings. Keep operational queue IDs and task state out of persona files and public responses.
- Allow more image batches for the same persona while work is running; show running and waiting batches together and preserve an open prompt dialog during polling. Count completed photos plus queued/running additions against each style's six-photo limit. Adopt the latest preview at worker start. Keep source editing, deletion and saving locked until all that persona's queued work finishes.
- Image count defaults to **1** and increases only by operator selection. Initial creation offers 1–6 per style and shows the doubled total; additional generation targets one style within its six-photo capacity, and individual regeneration always makes one. Preserve the count for a failed same-target retry; reset a different target to one.
- Keep the optional prompt scoped to its image/action. Preserve it for a failed same-target retry; start a different target with an empty prompt. Keep prompt text in private editing drafts and exclude it from persona files, public API responses and logs.
- Create initial main portraits in both styles. Store each style's main and independent secondary images without scene/pair IDs, completion records or persistent recommendation plans. Suggestions are ephemeral; add, regenerate and delete one selected image while preserving the others. Changed names or character descriptions require whole-profile regeneration before saving.
- Generate self-presentation: photos the persona would choose for a dating profile and a first-person introduction they would actually write. Express private emotional darkness only as a subtle undertone. Vary selfies, friend-taken snapshots, travel/full-body and everyday pictures instead of imposing headshot framing or illustrating internal pathology.
- New persona creation defaults to female, with the male option disabled in both the UI and creation boundary. Keep the character and image prompts capable of representing either gender; legacy records without a gender continue using their descriptions.
- When changing authoring or image generation, read the latest workflow section in `docs/specs/persona-discovery-admin.md` for reference, retry and publication behavior.

## Logging

- At boundaries that turn failures into user responses or background-task results, emit structured diagnostics before handling the failure. Preserve the underlying cause and error code; a generic user-facing message is not a diagnostic.
- Correlate request and operation events with a server-generated request ID. Record the operation, stage, outcome and duration; include relevant persona ID, model, portrait style and upstream HTTP status. Make the request ID available on error responses so operators can find the corresponding logs.
- Use `info` for lifecycle events, `warn` for expected input/conflict failures and `error` for generation, persistence and unexpected failures. Runtime sinks write one JSON event per line to stdout (`info`) or stderr (`warn`/`error`). Reuse the application's logging path; `apps/admin/src/logging.ts` is the Admin implementation.
- Log a failure's diagnostic once per operation, with a completion summary at the request boundary. Observe each parallel task so a sibling failure remains visible after the request has returned.
- Keep credentials, authorization headers, signed drafts, handles, conversation text, private persona descriptions, prompts and image bytes/base64 out of logs. Allowlist provider diagnostic fields, redact echoed secrets/private inputs and bound diagnostic strings. Replace payload-bearing schema/JSON errors with a safe summary and retain stack frames separately.
- Test failure logging through the real request/task boundary: assert correlation, stage/cause metadata and sensitive-data exclusion alongside the existing recovery behavior.

## Ports

Assign a stable, uncommon default per local service: **3000–3999 for frontends**, **4000–4999 for backends**, and **5000–5999 for auxiliary services**. A browser-facing full-stack app uses the frontend range; a separate API listener uses the backend range.

Before choosing a default, check existing service configs and local listeners for collisions. Keep ports configurable through per-app environment variables, and update launch commands, frontend proxies, `.env.example`, and documented URLs together. Vite development and preview servers use `strictPort: true` so a busy default is reported rather than silently changed.

Tests that bind real listeners use port `0` for OS allocation. Existing deployed listeners and third-party internal ports follow their deployment contracts; changing them also requires updating the corresponding tunnel/proxy mappings.
