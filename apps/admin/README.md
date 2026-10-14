# Persona Admin on Cloudflare

Admin runs as a Worker. Drizzle owns the D1 schema; a private R2 bucket stores
immutable generated images. One SQLite-backed Durable Object (`PersonaAdmin`,
named `global`) owns private drafts, the image FIFO and submission deduplication.
New Catalog schemas start empty. Existing saved Markdown and images can be
explicitly imported into local D1/R2 with the one-off command below.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and set local credentials. `PORT` is a
process environment variable; its default remains 3729.

```sh
bun run --cwd apps/admin db:local
bun run --cwd apps/admin dev
```

Open `http://127.0.0.1:3729` using Basic authentication (`admin` and
`ADMIN_PASSWORD`). Wrangler persists local D1, R2 and Durable Object state under
`.wrangler/`. Browser and edge SSR bundles are built before Wrangler starts.
Worker builds use `workerd` export conditions, avoiding browser DOM helpers.

### Import existing local Admin data

Stop the local Admin while transferring data, then run:

```sh
bun run --cwd apps/admin import:local --check
bun run --cwd apps/admin import:local
```

The default source is `apps/admin/data/personas`. Pass a source directory after
the command to import another saved Catalog. `--check` only scans and compares;
the command rejects `--remote` and disables remote bindings explicitly. It uses
the same `.wrangler/state/v3` D1/R2 state as `wrangler dev`.

The transfer preserves IDs, Markdown, management metadata, publication and
per-style photo ordering. Every image original, including unreferenced
candidates, is uploaded under its existing filename with verified SHA-256 and
MIME metadata. Only current references become D1 photo links. The source folder
is read and retained. No AI calls are made.

Only the current initial State/Memory pair is copied. Missing pairs become
empty columns and are listed in the report. Existing public records retain
their publication even when they predate today's publication-readiness checks;
normal operator saves still require all current checks. Re-running skips
matching rows/objects and refuses conflicts instead of overwriting edits.
Uploads are verified before all new Persona rows and links are committed in
one D1 batch; a failed SQL statement rolls back that batch.

The standalone Discovery API defaults to `PERSONA_CATALOG_URL=http://127.0.0.1:3729`.
The messaging application and Worker both use `TOKEN_CATALOG` with the same
value for private Catalog access. The application refreshes revisions once a second and on native
session events. Its selection response uses absolute Worker image URLs, which
also work in the existing Discovery client.

## Deploy

The production domain is `admin.ambivalent.dev`, using the `persona-admin` Worker
in the `Ambivalent Co.` account. Wrangler references the remote `persona-catalog`
D1 database in that account. A new remote Catalog starts empty;
`import:local` does not populate remote resources.

The D1 schema and private R2 bucket `persona-images` are provisioned.
Set separate production secrets interactively from `apps/admin`:

```sh
bunx wrangler secret put ADMIN_PASSWORD
bunx wrangler secret put TOKEN_CATALOG
bunx wrangler secret put TOKEN_MANAGEMENT
bunx wrangler secret put GEMINI_API_KEY
bun run db:remote
bun run deploy
```

Wrangler declares the Durable Object binding and initial SQLite class.
Generate schema changes with `bun run db:generate` and apply them before code
that needs them. The initial SQL creates an empty schema only. Check packaging
and bindings with `bunx wrangler deploy --dry-run`.

Deploy the updated session-folder plugin before the messaging application: its
optional `documents` snapshot field initializes new Conversation folders with
`STATE.md` and `MEMORY.md`. Catalog updates preserve evolving Conversation
documents; session snapshots include the current pair for export/restore.
Point both API services at the same Worker. Publish newly authored personas
before fresh onboarding. Any configured default must be an actual published ID.

### Workers Builds

After provisioning and setting runtime secrets, connect this repository to
`persona-admin` under **Settings → Builds**:

| Setting                      | Value                                                        |
| ---------------------------- | ------------------------------------------------------------ |
| Production branch            | `main`                                                       |
| Root directory               | `apps/admin`                                                 |
| Build command                | `bun install --cwd ../.. --frozen-lockfile && bun run build` |
| Deploy command               | `bun run db:remote && bun run deploy`                        |
| Build variable `BUN_VERSION` | `1.4.2`                                                      |

Use a deployment token with Workers, D1 migration and domain-routing access.
Initially watch the entire repository to include shared-package/schema changes.
Workers Builds needs the explicit build command even though local Wrangler
declares a custom build. Disable previews until isolated data and secrets are
configured. Keep GitHub's `Quality gates` check required before merging into
`main`; Cloudflare does not wait for it before deploying.

Set `ADMIN_PASSWORD`, `TOKEN_CATALOG`, `TOKEN_MANAGEMENT` and `GEMINI_API_KEY` as Worker runtime
secrets, not browser/build variables. Set the messaging application's
`PERSONA_CATALOG_URL=https://admin.ambivalent.dev` and its private
`TOKEN_CATALOG` to match the Worker's `TOKEN_CATALOG`. Deploy that application
configuration separately. Verify unauthenticated `/` returns 401, authenticated
editing works, and only published current image references are public.

## Storage and recovery

### Waiting people and first contact

`/waitlist` lists registrations from the messaging API, not Admin D1. Enter
1–100 people and confirm **N명 선정하기**. The server randomly chooses people
with currently public, unassigned Likes, then assigns one available liked
persona to each. The result may contain fewer than N people. A persona belongs
to one handle from reservation onward, including failed/uncertain attempts.
Each selected Greeting is scheduled once 5–60 minutes later.

`/first-contacts` shows reservations, session preparation, Greeting processing,
confirmed first sends, failures, unreachable iMessage contacts and results
requiring inspection. Refresh to observe progress. Network/response loss keeps
the selection key for confirmed re-submission; it does not select another batch.
Opening a fresh selection form and confirming it is a new operator action with
a new key; prior selection keys remain durable for transport retries.
An unavailable API is an error, not an empty list. Uncertain sends and interrupted
preparation are never automatically repeated. Inspect the API's recorded
session/send before recovery; deleting a user through the operator removes the
registration and releases the assignment.

Set Worker `MESSAGING_API_URL=https://api-msg.hena.dev` (declared in Wrangler)
and runtime secret `TOKEN_MANAGEMENT`, matching the application's
`TOKEN_MANAGEMENT`. Use a different value from `TOKEN_CATALOG`. Tokens remain
server-side; Admin authenticates the operator and enforces same-origin POSTs.
The application serves Bearer-authenticated `GET /management/discovery` and
`POST /management/discovery/select`. Deploy the API before Admin; the old API's
404 or missing credentials are displayed as connection failures. SQL schema
019 adds assignment, selection deduplication and durable contact records. On
startup, conflicting existing live assignments stop admission rather than
silently removing conversations. Resolve those records on the API host first.

### Token names and removal of old settings

Both applications now use the same names for each purpose, with two distinct
values:

| Setting            | Direction                     | Purpose                                       |
| ------------------ | ----------------------------- | --------------------------------------------- |
| `TOKEN_CATALOG`    | Messaging application → Admin | Read private Persona/State/Memory Catalog     |
| `TOKEN_MANAGEMENT` | Admin → Messaging application | List waiting people and select first contacts |

Keep value A for `TOKEN_CATALOG` identical in both apps, and value B for
`TOKEN_MANAGEMENT` identical in both apps. A and B are different. Existing
values can be retained; changing the names does not require generating new
credentials. If management has not been configured, create only value B.

Replace these settings in local `.dev.vars`, protected application environment
files, deployment/secret-manager settings and any local setup files:

| App                   | Remove old name         | Set new name with its existing value |
| --------------------- | ----------------------- | ------------------------------------ |
| Admin                 | `CATALOG_TOKEN`         | `TOKEN_CATALOG`                      |
| Admin                 | `MESSAGING_API_TOKEN`   | `TOKEN_MANAGEMENT`                   |
| Messaging application | `PERSONA_CATALOG_TOKEN` | `TOKEN_CATALOG`                      |
| Messaging application | `DISCOVERY_ADMIN_TOKEN` | `TOKEN_MANAGEMENT`                   |

Set the new names first, deploy/restart the renamed code on both sides, and
verify private Catalog reads plus Admin waiting-list operations. The new code
does not read old names. Once both deployments have switched, delete obsolete
Worker secrets from `apps/admin`:

```sh
bunx wrangler secret delete CATALOG_TOKEN
bunx wrangler secret delete MESSAGING_API_TOKEN
```

Delete only secrets that exist. Leave `ADMIN_PASSWORD`, `GEMINI_API_KEY`,
`IMSG_TOKEN`, `REN_AI_APPLICATION_TOKEN` and `OPENCODE_AUTHORIZATION` in place;
they serve other authentication/provider purposes. Public `MESSAGING_API_URL`
and `PERSONA_CATALOG_URL` settings are unchanged.

- Persona, initial State and initial Memory are D1 text columns. Downloaded
  `persona.md` is a serialized view, not another source of truth. A revision CAS
  and atomic batch commit documents and photo links together; a losing writer
  cannot replace the winner's links.
- Upload to R2 before referencing a photo in a draft. Saving publishes the
  current links. `/images/<key>` requires operator authentication;
  `/discovery/images/<key>` requires a current published reference. Unpublishing
  or removing a reference makes the public URL return 404. Originals remain.
- Each alarm processes one photo. Persist `generating` before a paid call and
  checkpoint the completed URL and preview together. An interrupted in-flight
  photo needs an operator-confirmed retry; completed siblings and deduplication
  survive restarts. Interrupted shared preparation blocks dependent photos.
- Allow more batches while work runs. Completed photos plus reserved additions
  count against six per style. Adopt the latest preview at start and reject
  stale sources/targets before generation. Lock source editing, deletion and
  saving until that persona has no pending work.
- Prompts, drafts and queue identifiers stay outside Persona rows and public
  responses. Persist drafts and batches separately to avoid one growing value.
- Missing Catalog IDs preserve remote session snapshots privately, without
  offering those personas for new onboarding.

## Diagnostics and checks

### US execution and image editing

Production uses `ADMIN_JURISDICTION=us` and the US-restricted `PersonaAdmin`
object named `global`. This is a different object from the former unrestricted
`global`: saved D1 documents and R2 photos remain, but its private unsaved drafts
and queue are not carried over. Alarms on the former object stop without making
new generation calls. Already submitted upstream requests cannot be cancelled.
Do not set `ADMIN_JURISDICTION=local` in production. The `dev` command explicitly
sets it for workerd, which does not implement jurisdiction restrictions.

Finished image jobs have **기록 삭제** and **종료된 기록 모두 삭제** actions.
There is no automatic expiry. These actions remove finished task records, not
photos or the latest draft; pending/running work remains. Submission receipts
remain so replaying a deleted paid submission cannot create more images.

Drop one PNG, JPEG or WebP (up to 20 MB) into a style's upload area, or select
**사진 업로드** / **파일로 교체**. Every upload requires a 4:5 crop confirmation;
position and zoom controls produce a 1024×1280 JPEG. Uploads use the private R2
preview and become public only after **저장하기**. Each style still allows six
photos. Upload/replace is locked while that persona has queued generation.

Structured JSON goes to Workers stdout/stderr. Search Workers Logs or
`bunx wrangler tail` using the displayed request ID / `X-Request-ID`.
Diagnostics retain stages, causes/codes and durations, excluding Persona text,
prompts, tokens and image bytes. File logging and the Persona Lab key fallback
are removed. Use Node 24 for `bun run ci`.

Tests use real local D1/R2, the built Worker/DO entry, persistent queue recovery
and Catalog consumer boundaries. `cloudflare:workers` is provided by the
platform; Knip excludes that runtime import from npm dependency checks.
