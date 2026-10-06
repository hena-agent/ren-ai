# ren-ai

An iMessage service for conversations with fictional personas. This Bun and Turborepo monorepo includes persona discovery, persona Admin, the discovery.hena.dev site, the Mac messaging API and remote OpenCode plugins, a local Persona Lab, and a standalone persona engine. Seven quality gates block CI.

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

Admin creates OpenCode personas from a name and detailed private character description. A brief idea can generate an editable AI character draft. AI writes a first-person dating-profile introduction and creates self-chosen profile photos in LovePlus-inspired Japanese 2D anime and near-photorealistic styles. Operators choose the image count, then add, regenerate or delete independent photos. IDs and runtime instructions are managed internally. `apps/discovery` supports style selection, swipe, Like / Pass and web-consented waiting registration. `packages/discovery.hena.dev` lets a visitor select a published persona and continue through handle/consent onboarding into a conversation.

Start Admin with a password:

```sh
ADMIN_PASSWORD='<operator password>' bun run --cwd apps/admin dev
```

Open http://127.0.0.1:3729 and sign in as `admin`. New personas default to **여성**; the **남성 · 준비 중** option is disabled, with the same restriction at the creation boundary. Write a name and detailed description directly, or enter a brief idea to create an editable AI draft. **프로필 생성** defaults to one photo per style (two images total). The options dialog lets you explicitly choose one to six per style and shows the actual total before confirmation. Afterwards, **이미지 추가** makes photos only in the selected style, defaulting to one. Each photo has **이 이미지 다시 생성** (one replacement) and **이 이미지 삭제**. Other photos and the introduction are preserved. **자기소개만 다시 쓰기** updates the biography without image calls. Save with publication enabled to expose the preview in Discovery. An unfinished character can be saved privately. Descriptions stay private; first-message and memory instructions derive from service rules, and the OpenCode prompt incorporates the description.

Every image-generation action opens an image-options dialog with one optional prompt **per actual photo**. Two additional photos have two inputs; two per style initially have four. Confirm it to start paid generation; each blank prompt uses normal character/style/reference direction. The count defaults to one and increases only when the operator selects more. A failed retry retains that photo's prompt; choosing a new action starts at one with blank inputs. Prompt text remains in private editing drafts and the operational queue, excluded from persona files, public API responses and logs. Editing a name or description disables image-only actions and reveals **원본 변경 후 전체 프로필 갱신**; regenerate the whole profile before saving a changed definition.

Admin uses `GEMINI_API_KEY`, or the existing key in `apps/persona-lab/.env` when unset. Its default models are `gemini-3.8-flash` for introductions and `gemini-3.1-flash-image` for 4:5 portraits. Override them with `ADMIN_TEXT_MODEL` / `ADMIN_IMAGE_MODEL`, and the provider's API base with `GEMINI_API_URL`. Keys stay on the server. Admin renders HTML and bundles only its small progress script in memory at startup.

All initial, additional and regeneration images share one process-local FIFO worker and run **one at a time**. Browser submissions are acknowledged promptly and open an authenticated `/image-jobs/<id>` progress screen. It shows running and waiting batches together, per-photo states, elapsed time and completed thumbnails. Operators can queue more additions or individual regenerations for the same persona while generation is running, and polling preserves an open options dialog. Capacity includes completed photos plus waiting/running additions within each style's six-photo limit. Each batch adopts the latest preview at worker start so earlier photos survive. Reloading restores active progress; source editing, deletion and saving stay locked until all that persona's work finishes. Queue IDs and task state remain private operational metadata.

Main anime and photo images are generated independently from the same character description. Additional photos reference only their own style's main image; individual secondary regeneration also references the current photo for composition. Photos express what the person would choose to upload to a dating profile: selfies, friend-taken snapshots, everyday moments, hobbies and travel/full-body pictures. Private emotional darkness remains a subtle undertone. The biography uses the person's own voice rather than a character summary. Each style permits a main image and up to five independent additional photos.

Generation and image-save failures preserve the published profile. Every batch, including the default two-style creation, retains completed outputs while other runnable photos proceed. A missing initial main blocks only that style's dependent photos without image calls. **이 사진만 재시도** confirms and queues one failed/blocked photo with its own prompt; completed siblings are preserved. Each new browser confirmation can add a batch with identical options; retransmitting that confirmation returns the existing job without duplicate payment. Rejected registrations retain active progress and source locks. The signed preview remains saveable after a restart; active queue state lasts for the Admin process. Deleting a main promotes a remaining photo of that same style; deleting all photos makes the preview unpublished. Saving commits the change; physical image files are retained, while unreferenced public image URLs return 404. Diagnostics correlate enqueue/retry requests with each image's job, style, index, stage and cause without logging private directions, prompts or image bytes.

Admin stores optional `portraits` (style-specific mains) and `secondaryPortraits` (independent `{ style, imageUrl }` photos, stored as `secondary-portraits` in Markdown). `imageUrl` remains for older clients. Legacy `portraitGallery` / `portrait-gallery` pairs migrate to these fields on read without regenerating images; new files and public responses contain no scene IDs, recommendation plans or completion records. Discovery displays only the selected style's available photos, with previous/next controls on cards and profile details. A style with no photos displays a placeholder. Photo navigation does not create a Like or Pass. Deploy API readers for the optional image and gender fields first, then Discovery, before Admin saves the new format. Existing paired, single-image and old API responses remain usable.

The API's local `TURNSTILE_SECRET` is set in `packages/api-msg.hena.dev/.env.example`. Run the apps with the root `bun run dev`; `packages/api-msg.hena.dev` also offers `dev:discovery` for the standalone swipe-registration API. For that API and `apps/discovery`, use separate terminals:

```sh
TURNSTILE_SECRET=1x0000000000000000000000000000000AA bun run --cwd packages/api-msg.hena.dev dev:discovery
bun run --cwd apps/discovery dev
```

Open http://127.0.0.1:3867 and choose anime or realistic display for the whole catalog. The style is restored across reloads and can be switched while browsing or entering contact details without resetting choices or inputs. Use the up-arrow to expand the profile in the same browsing area. Photo/text taps do not open it; the down-arrow or Escape collapses it while preserving the selected photo. The name/collapse header stays accessible while photos and the public introduction scroll. Shared floating Pass/Like circles sit above the content, with a soft bottom fade and enough reading/safe-area padding to reveal the last introduction line. Desktop retains the sidebar; mobile reading uses the full screen. Outside clicks leave the reading profile open. Reading liked profiles preserves the current card and any typed contact details. Its Vite proxy calls the API on port 4867, including every generated gallery image. The frontend and backend use Cloudflare's public test keys locally. Defaults share Admin's `apps/admin/data/personas` directory and store registrations in `packages/api-msg.hena.dev/data/discovery.sqlite`. Generated portraits live in the persona directory's `images/` subdirectory; include it with the Markdown files in persona backups. All images referenced by a published persona are served publicly; unpublished and unreferenced images remain private. `PERSONA_DIRECTORY` and `DISCOVERY_DATABASE` override the API's paths. Use `PORT` per process to change its default port and `DISCOVERY_API_URL` to change the frontend proxy target. Vite reports busy ports instead of switching silently.

For public hosting, configure the browser app's `VITE_DISCOVERY_API_URL` and real `VITE_TURNSTILE_SITE_KEY`, and the API's matching `TURNSTILE_SECRET`. The standalone swipe API serves `/discovery/personas` and `/discovery/waitlist`; the messaging API also serves `/personas` and `/onboarding` for the prerendered `discovery.hena.dev` site. Both use the messaging service database and permit the canonical `https://discovery.hena.dev` origin. Deployment and domain cutover are tracked in the [MVP spec](docs/specs/persona-discovery-admin.md). See the site and API `.env.example` files for configuration.

Quality checks use Node 24 from `.nvmrc`.

```sh
nvm use
bun run ci:checks
```

`bun run test` launches Vitest with Node from `PATH`, not Bun. Node 22 cannot parse
OpenCode's `await using` syntax and reports `SyntaxError: Unexpected identifier '_'`;
database tests can wrap that import failure as `An error occurred in Effect.tryPromise`.

Discovery uses a viewport-filling swipe layout on mobile, with round Pass / Like controls and bottom navigation. Desktop adds a liked-persona sidebar beside the large card. Only the up-arrow opens a full public profile; photo, name, introduction, and outside taps do not toggle it. The down-arrow collapses it, and Escape remains available. Photo navigation controls change only the selected photo. Floating Pass / Like buttons remain above the scrollable profile content. Only swipes, those choice buttons, or arrow keys choose Like / Pass. Exit animations complete a choice once, with immediate completion for reduced motion. Liked profiles, image style and registration behavior remain shared across both layouts.

## Layout

```
apps/admin/            Password-protected OpenCode persona editor; server-rendered HTML.
apps/discovery/        Browser persona cards, Like / Pass and waiting registration.
apps/persona-lab/     Local simulation app for the standalone persona engine.
packages/personas/     Shared OpenCode persona loader, validation and file store.
packages/persona-engine/  Relationship state engine (not wired into iMessage runtime).
packages/onboarding/   Shared browser-safe Handle, disclosure, persona catalog and registration shapes.
packages/discovery.hena.dev/   Prerendered Korean persona selection and onboarding site.
packages/api-msg.hena.dev/  Mac messaging API, portable application, deployment tooling, and operator CLI.
packages/plugins/    OpenCode runtime plugins and shared application RPC client.
scripts/                Repo tooling: exceptions report and gate verification.
quality-exceptions.json  The only place file-level gate exceptions may live.
```

## The gates

For the messaging services, use the [deployment and relocation runbook](packages/api-msg.hena.dev/ops/README.md). The [service boundary decision](docs/adr/0010-separate-the-messages-mac-from-opencode.md) records the Mac/Docker split and the native OpenCode interface at `oc.hena.dev`; [ADR-0012](docs/adr/0012-each-session-runs-in-its-own-opencode-folder-written-by-a-plugin.md) adds per-session native agent/instruction folders and their separate persistent volume.

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

`bun run ci:checks` runs formatting, lint, types, tests and builds. GitHub Actions runs `ci:checks` and `verify-gates` in parallel; deployment waits for both. `verify-gates` plants deliberate violations and confirms that each gate rejects them.

## Design decisions worth knowing

- **bun installs and runs scripts; Node runs tests.** Vitest treats bun as a package manager only, and the v8 coverage provider does not work on the bun runtime.
- **Libraries are Just-in-Time.** They export TypeScript source directly, with no build step. The messaging site, Discovery and Persona Lab build their browser UIs with Vite; the lab builds when starting. An unbuilt compiled library makes type-aware lint and knip exit 0 while enforcing nothing — a silent false pass.
- **Exact version pins, no ranges.** oxfmt is pre-1.0 with no semver protection on formatting output, and `oxlint-tsgolint` is hard-pinned to a TypeScript patch release.
- **bun's default isolated linker is kept.** It turns an undeclared dependency into an immediate failure instead of a latent bug.
- **`globalStore = true` in `bunfig.toml`.** Packages are symlinked from one machine-wide store, so a clone's `node_modules` is ~200KB instead of ~240MB.
