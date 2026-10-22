# Separate application, OpenCode, and Messages deployments

## Cloudflare application and controlled cutover

`@ren-ai/api-app` is the stateful Worker at `https://api.renai.im`;
`@ren-ai/api-msg` is the DB-free Docker executor on the Mac at `https://api-msg.renai.im`.
The executor forwards to `https://oc.renai.im` and
`https://imsg.renai.im/rpc`. Discovery registration and Admin management use
api-app; Discovery also reads its public profiles through api-app's persisted
public Catalog cache (60 seconds fresh, up to 300 additional seconds stale on
upstream failure). Registration and Selection revalidate against Admin directly.

Local `bun dev` serves api-app at `http://127.0.0.1:4879` and its Wrangler
debugger at `http://127.0.0.1:5879`. Export `API_APP_PORT` or
`API_APP_INSPECTOR_PORT` to override these process-level settings.

The root `bun dev` starts both api-app and api-msg. Copy each app's `.env.example`
to `.env` before starting. api-app loads local Worker bindings from `.env` and
connects to `http://127.0.0.1:4700`. Keep `TOKEN_MANAGEMENT` identical in Admin,
api-app and api-msg, and `TOKEN_CATALOG` identical in Admin and api-app.
The example keeps bootstrap mode enabled until explicitly configured for execution.

CI deploys api-app only from `main` after every quality gate, then probes its
safe health and public Catalog endpoints. The production Wrangler config sets
`BOOTSTRAP_ONLY=false` after the verified shared-life cutover, so deployments run
intake and background scheduling.
The old application must remain stopped to prevent duplicate intake. For a
state restore, set bootstrap-only mode while importing and verifying the
archive, then restore `false`. No script changes live ingress or stops a service.

After old intake and scheduling are stopped, create an owner-only private archive:

```sh
# state:export runs Node 24 (node:sqlite URI support preserves readonly WAL reads).
CONFIRM_APPLICATION_STOPPED=yes bun run state:export /private/path/server.sqlite /private/path/new-state.json
API_APP_URL=https://api.renai.im bun run state:import /private/path/new-state.json
```

Load `TOKEN_MANAGEMENT` from a protected environment. The exporter opens the
source read-only and exclusively creates a mode-0600 JSON archive. Import is
authenticated at `POST /management/state/import`, works only in bootstrap mode,
and atomically restores into an empty application database. Repeating the same
archive is idempotent; a different archive, incompatible columns or nonempty
target is rejected. `GET /management/state/export` is an authenticated private
verification snapshot. Archives contain handles and conversation text: keep
them out of Git/logs and preserve IDs, bookmarks and uncertain sends.

Copy `apps/api/.env.example` to `apps/api/.env` for local Worker development.
`bun run dev` listens on `API_APP_PORT` (default 4879). Local state belongs to
Wrangler's DO persistence, never a running Mac `server.sqlite`. Local bootstrap
mode remains enabled by default; production's `false` setting is in
`wrangler.jsonc`. SQLite DO point-in-time recovery replaces the retired local
nightly database snapshots; OpenCode's session documents remain in the existing
OpenCode storage and exports.

Reuse api-app's existing private `TOKEN_MANAGEMENT` secret and
`API_MSG_URL=https://api-msg.renai.im`. Provision the Mac executor once through
the [Docker deployment procedure](../../api-msg/ops/README.md): create its Compose project, tunnel and
protected environment with the same `TOKEN_MANAGEMENT`, plus `OPENCODE_URL`,
`OPENCODE_AUTHORIZATION`, `IMSG_URL` and `IMSG_TOKEN`. It has no Turnstile secret
or local application database. Thereafter the Mac consumes the attested bundle
published from `main`; it does not receive a manual deploy or alter the native
imsg protocol.

## Discovery and Admin

`GET /health` identifies `api-app` and the exact source revision embedded in the
Worker. Database, authenticated `api-msg` and a direct no-send Messages/APNs probe
are separate dependencies. An unavailable, unauthorized or wrong-service executor,
or an unavailable messaging transport, makes overall health
`degraded` (HTTP 503), even while public Catalog reads remain available.
`bootstrapOnly` reports the intake setting separately. Local runs use revision
`development`; responses exclude credentials and upstream payloads.

CI checks the running Worker service and exact revision. Probes retry up to ninety-six
times, five seconds apart, with a ten-second timeout per request so deployment
propagation has up to 15 minutes to reach the Durable Object. Health identifies the
edge Worker artifact and separately reports the Durable Object runtime revision/readiness;
an older DO is marked degraded while the deployed Worker identity can be verified.
Each failed probe records
allowlisted expected/actual revisions, readiness and HTTP status without upstream
response bodies. An old revision never satisfies the check. Admin additionally
requires editor readiness. API rollout records degraded
dependency health without blocking artifact publication: the Mac updater needs
the completed CI run before it can install that artifact. Verify executor health
again after the Mac update before declaring an end-to-end deployment ready.

### Messaging health and background recovery

The alarm probes the existing Messages RPC through api-msg every two minutes.
The native bridge checks APNs ping/pong and Apple registration readiness without
sending a message. After a failed check, the persisted deadline advances by
20 seconds; two consecutive failures raise `messaging-unavailable`. A successful
check clears it and restores the two-minute interval, including after actor
replacement. Public `/health` independently probes with a five-second deadline
and reports `messaging: ready|unavailable`; it never waits for the alert threshold.

Use the response's request ID to find `api-app.health` / `messaging.probe` and its
Mac operation ID, then inspect that operation in the imsg logs. Verify the local
imsg health and the public tunnel's exact artifact revision before restarting
anything. Restore a sleeping/offline Mac or a stopped bridge through its existing
LaunchAgent/updater procedure. APNs/registration failures may require the logged-in
operator to restore connectivity or Apple Account registration; an HTTP-ready
executor alone does not establish recovery. Confirm both dependencies are ready
and the alert clears. A transport timeout never authorizes resending an uncertain
message or releasing an Assignment.

Each alarm stops admitting new items after 45 seconds or 40 admissions; SQL batches
are at most five items. This is an admission budget, not a hard cancellation of an
in-flight mutation. Existing per-operation deadlines still apply. Lane rotation,
retry deadlines, per-session turn probes, Catalog scan/apply cursors and replay
checkpoints persist in SQLite. Deferred work resumes after one second; a failed
lane/session backs off from 30 seconds to five minutes without holding healthy
lanes behind it. Failed startup releases partially acquired resources and can
resume in the same actor. Health runs independently of execution startup backoff.

Normal intake history queries and Mac follow backlog use 100-row pages; replay
uses Handle/row cursors, and quote/reset/Tapback lookups use bounded GUID/latest
queries. A first-ever intake bookmark still reads the existing history to establish
the starting tail. Once a bookmark exists it is not repeated. Deploy the additive
recent-query protocol to the Mac to get SQL-side limits; the client continues
filtering responses from a Mac that has not yet updated. api-msg resets reconnect
backoff after a follow subscription is successfully established. Idle observation
during blocked intake backs off from one second to 30 seconds and resets on progress.

### Public Catalog freshness

Only public profile fields enter the durable cache. Concurrent refreshes coalesce;
warm reads perform no storage writes. Failed refreshes retry after ten seconds
within the hard six-minute snapshot lifetime. A missing/expired snapshot yields
HTTP 503. Successful browse responses include `Age` and
`Cache-Control: public, max-age=60, stale-while-revalidate=300`; other responses
remain `no-store`. Registration and Selection never admit a stale-only candidate.
Admin's authenticated Catalog refresh invalidates the stored snapshot and fences
in-flight refreshes; already-cached browser/CDN responses can remain visible until
their HTTP freshness window ends. State archives exclude this reconstructible cache.

`renai.im` is the Discovery app in `apps/discovery`, and `admin.renai.im` is the
Catalog and authoring Worker in `apps/admin`. GitHub Actions deploys both after the
quality gates; see the [Discover setup](../../../apps/discovery/README.md) and
[Admin setup](../../../apps/admin/README.md#automatic-deployment). Point the
application at `https://admin.renai.im` with the matching private Catalog token;
deploying either website does not redeploy the application.

## Operator commands

From a dependency-installed checkout in `apps/api`, set `API_APP_URL` to the
central HTTPS application origin and load `TOKEN_MANAGEMENT` from the protected
operator environment. The typed CLI calls authenticated `/operator` routes;
it never opens an application state directory or Unix socket:

```sh
API_APP_URL=https://api.renai.im bun run operator remove HANDLE
```

The commands are `remove`, `block`, `rebuild`, `test-handle` and `untest-handle`,
each taking one handle.

### Recover a blocked send

Deploy the matching imsg gateway first and verify its exact revision and readiness
locally and through the public tunnel. Then deploy api-app. New text attempts
persist an identity before submission; on the next delivery check/send, the Mac
either reports its outcome or durably rejects the missing attempt. An admitted
but unconfirmed attempt stays uncertain. Neither path automatically resends it.

For a legacy attempt, inspect its exact OpenCode tool call and the old transport's
history. Establish that the original executor/request can no longer send and
verify non-delivery with the operator/recipient; absence from history alone is
not proof. The following command is an explicit non-delivery attestation for
that **one legacy call**, not a reset or a resend:

```sh
API_APP_URL=https://api.renai.im bun run operator release-send HANDLE CALL_ID
```

It rechecks transport evidence before changing anything. `released` records a
legacy failure, `settled` means transport evidence or a prior recovery already
settled it, `uncertain` means an identified native attempt still cannot be released,
and `not_found` means the Handle/current Conversation does not own that call.
Repeating the same command cannot release a different attempt. Completed sends,
Conversation identity, State and Memory are preserved. The next model context
reports the failed send honestly, and a fresh send can proceed after all earlier
uncertainty is resolved. Recovery failures include a request ID for the logs.

The Dockerfile now builds only plugin-installation and explicit offline-export
artifacts. `compose.yml` retains the plugin installer and original volume names,
not an application listener or tunnel. The obsolete Docker serving/deploy path
has been removed; api-app runs as the Worker, and api-msg's separately provisioned
runtime is owned by `apps/api-msg`. This cleanup does not move OpenCode, Messages,
their ingress, or any existing volume. The stopped legacy volume remains available
for the coordinated read-only state export.

## Retire the old test site

The persona-selection site at `discovery.hena.dev` and its immediate onboarding are
gone ([ADR-0015](../../../docs/adr/0015-discovery-is-the-only-onboarding.md)). Every
conversation it started was test data. Retire it in this order:

1. After the coordinated state import, take each legacy test handle from the
   reviewed export and `remove` it with the [central operator CLI](#operator-commands),
   so no conversation from the old flow remains. Do not attach a new writer to
   the stopped legacy SQLite volume.
2. Delete `DEFAULT_PERSONA_ID` from the protected application env file and deploy
   the application. Migration 020 drops the email waitlist and leftover Notice
   records; the old site's routes now answer `404`.
3. In the hena.dev Cloudflare account, delete the `discovery-hena-dev` Worker and
   its `discovery.hena.dev` custom domain, and remove that hostname from the
   Turnstile widget.
4. Retire credentials for the old account. Keep `CLOUDFLARE_API_TOKEN` for the
   current Ambivalent Co. Worker deployments.

## Move to renai.im

[ADR-0016](../../../docs/adr/0016-the-service-lives-at-renai-im-in-one-cloudflare-account.md)
moves every hostname except `fleet.hena.dev` into the Ambivalent Co. account. Retire
the old test site first; with no live conversations left, the move is one planned
pause.

Before merging:

1. In the Ambivalent Co. account, provision the Mac executor tunnel for
   `api-msg.renai.im`, plus the existing Mac endpoints:
   - `api-msg.renai.im` → `http://api-msg:4700` on its Docker Compose network
   - `imsg.renai.im` → `http://127.0.0.1:4702` (the Messages Mac)
   - `oc.renai.im` → the auth proxy origin that the `oc.hena.dev` tunnel uses today
2. Create an Invisible Turnstile widget for `renai.im`. Put its site key in the
   `TURNSTILE_SITE_KEY` repository variable and keep its secret for step 8.
3. Create an Ambivalent Co. API token with Workers Scripts, D1 and Workers R2 Storage
   (Edit), Account Settings (Read) and Workers Routes (Edit) on `renai.im`. Store it as
   the `CLOUDFLARE_API_TOKEN` repository secret and delete
   `CLOUDFLARE_API_TOKEN_AMBIVALENT`.
4. In the `renai.im` zone, add a proxied `www` record and a redirect rule from
   `https://www.renai.im/*` to `https://renai.im/${1}` (301, keeping the query string).

Cutover:

5. Before the initial state import, explicitly deploy api-app with
   `BOOTSTRAP_ONLY=true`; the production config defaults to `false`. Release any
   old tunnel route/DNS record at `api.renai.im` before assigning that custom
   domain to the existing Worker. Preserve its Worker identity and DO namespace.
   CI deploys Admin, Discovery and api-app after quality gates.
6. On the Messages Mac, follow [Move to imsg.renai.im](../../imsg/ops/README.md#move-to-imsgrenaiim).
7. In the external OpenCode Compose project, replace the tunnel token with the
   `oc.renai.im` tunnel's and recreate only that tunnel container. Sign in again at
   `https://oc.renai.im`.
8. Provision api-msg's Docker service/tunnel and protected environment once. Set
   `TOKEN_MANAGEMENT`, `OPENCODE_URL`, `OPENCODE_AUTHORIZATION`, `IMSG_URL` and
   `IMSG_TOKEN` there, and `API_MSG_URL=https://api-msg.renai.im` on the Worker.
   The Mac updater builds the attested `main` bundle into the executor image.
   Install a plugin location whose callback is `https://api.renai.im/rpc`.
   Verify/import state before enabling Worker intake, with the old intake stopped.
9. In Messages on the Mac, set **Start New Conversations From** to `hi@renai.im`.
10. Verify with a marked test handle: register on `https://renai.im`, start it from
    Admin's waitlist and confirm the Greeting arrives from `hi@renai.im`.

Then retire the old names:

11. Delete the `discovery-ambivalent-dev` Worker, any `admin.ambivalent.dev` custom
    domain left on `persona-admin`, the hena.dev-account tunnels for `api-msg`, `imsg`
    and `oc` with their DNS records, and the old Turnstile widget.
12. Remove `hi@hena.dev` from the addresses Messages can be reached at.

## Service deployment and relocation

### Discovery selection and first contact

The normal application listener serves `/discovery/personas` and
`/discovery/waitlist` alongside the plugin callback.
The management routes `/management/discovery` (GET),
`/management/discovery/select` and `/management/discovery/start` (POST) require `TOKEN_MANAGEMENT`, matching
Admin's `TOKEN_MANAGEMENT`. Keep this credential separate from `TOKEN_CATALOG`,
messaging and plugin tokens. Configure the Admin Catalog at
`https://admin.renai.im`. Current application state belongs to Durable Object
SQLite; preserve any stopped legacy volume only for reviewed export/rollback.

Each handle has one current Assignment; each persona has at most five, including
pending, failed and uncertain first contacts and test handles. Reservation checks
and writes share a transaction. Operator removal and test reset release their
Assignment; a failed, blocked or uncertain first contact retains its slot.
Relationship endings exclude that persona only for the same handle. Personas at
capacity remain visible in Discovery; Selection waits for capacity.

Selection and its 5–60 minute schedule commit together. The worker records a
session ID before creating its native folder, and records the Conversation
before enqueueing the Greeting with a stable inbox ID. Restart continues untouched due reservations and observes existing
preparations/sends without submitting a second Greeting. An interrupted or
uncertain attempt requires inspection; send failures and iMessage absence are
distinct from observed success. Request/task diagnostics are JSON with request
IDs and sanitized causes, excluding handles, tokens, private persona text and
message content.

Admin management uses `APPLICATION_API_URL=https://api.renai.im` and
`TOKEN_MANAGEMENT`; Discovery registration uses
`VITE_DISCOVERY_API_URL=https://api.renai.im`. Discovery profile reads use
api-app's `/discovery/personas`; the browser does not bind D1 or run a catalog API.

Admin sends `POST /management/catalog/refresh` with `TOKEN_MANAGEMENT` after
committing catalog edits. This route belongs to api-app, not the Mac executor;
it loads the latest authenticated Admin catalog and synchronizes persona
folders. Live State and both Memory scopes are preserved. Retained and ended
sessions use the same current agent and ground rules as active sessions. The
route returns 204 after synchronization, 503 on failure (with a request ID),
and rejects writes during bootstrap. Duplicate notifications are safe. Catalog
loading runs at execution startup and on notifications, never on heartbeats.
Admin retains and retries unacknowledged notifications across restarts.

No script below performs the live cutover, stops existing services, changes an existing Cloudflare ingress, or edits the external OpenCode deployment. Install/restore refuse existing destinations. Run scripts with `bash`; TypeScript edges run with Bun 1.4.2 from a dependency-installed checkout. Treat exported archives as private: they contain conversations and service credentials. Encrypt and copy backups off-host yourself; no paid service is required.

## Services and credentials

| Service     | Runtime                                                            | Persistent state                                                                                                        | Ingress / auth                                                              |
| ----------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Messages    | [Native Mac GUI LaunchAgent](../../imsg/ops/README.md), Bun + imsg | Apple Messages; dedicated messaging token                                                                               | `imsg.renai.im` → loopback 4702, Cloudflare Tunnel; Bearer                  |
| Application | `@ren-ai/api-app` Cloudflare Worker                                | SQLite-backed application Durable Object; remote Admin D1 Catalog                                                       | `api.renai.im`; plugin callback Bearer                                      |
| Executor    | `@ren-ai/api-msg` Docker container on the Mac                      | None                                                                                                                    | `api-msg.renai.im` → Docker; `TOKEN_MANAGEMENT`                             |
| OpenCode    | Existing `ghcr.io/anomalyco/opencode:2.0.19`                       | Whole `oc-hena-dev_opencode-home`, proxy signing state, read-only plugin location, writable persona and Sandbox folders | `oc.renai.im`; native Basic for machines, existing cookie flow for browsers |

The following host-relocation notes describe the prior Docker application deployment and are retained only for archived backup/rollback work. They do not provision or deploy api-app or api-msg. For the current Mac executor setup, use [api-msg provisioning](../../api-msg/ops/README.md). The current executor uses the existing OpenCode upstream through authenticated public `https://oc.renai.im`; do not alter its tunnel or proxy for api-msg.

The inspected Alpine/aarch64 OpenCode 2.0.19 image needs `gcompat=1.1.0-r4` and `LD_PRELOAD=/lib/libgcompat.so.0` for its bundled PTY library. Without both, terminal creation fails with `gnu_get_libc_version: symbol not found`. The deployed external Compose file includes a `compat/Dockerfile` with this same-version fix; preserve it during relocation. The OpenCode executable is unchanged. Verify a ticketed WebSocket shell roundtrip, not only the UI or `/api/info`.

The removed `application.env.example` applied to the old Docker application. For the executor's minimal protected environment, use [`api-msg.env.example`](../../api-msg/ops/api-msg.env.example): it reuses `TOKEN_MANAGEMENT`, native `OPENCODE_AUTHORIZATION`, and existing `IMSG_TOKEN`. The Mac needs no Turnstile secret, application database or provider credential.

Compose variables: `REN_AI_APP_ENV` (absolute protected env file), `REN_AI_TUNNEL_TOKEN` (application tunnel), `REN_AI_LOCATION_INPUT` (absolute reviewed plugin config/token staging directory). Volume names are overridable through `REN_AI_STATE_VOLUME`, `REN_AI_LOCATION_VOLUME`, `REN_AI_PERSONA_VOLUME` and `REN_AI_SANDBOX_VOLUME`. The application never mounts OpenCode volumes; folder writes use authenticated public plugin RPC.

The Catalog is the Admin Worker's Drizzle/D1 database and starts empty. Set
`PERSONA_CATALOG_URL` and `TOKEN_CATALOG` in the protected application
env file; the token matches the Worker's `TOKEN_CATALOG`. There is no file mount
or seed-copy step. See [Admin deployment](../../../apps/admin/README.md).
Admin pushes Catalog-change notifications; the application durably caches the revision and synchronizes native folders when it changes. Publish new
personas before Discovery offers them.
Missing IDs preserve existing session snapshots privately. Deploy the updated
session-folder plugin before the application so new Conversations receive
initial State/Memory while updates preserve existing documents.

## Native machine authentication adapter

Generate a **new review copy**, never edit the external source automatically:

```sh
bun apps/api/ops/patch-opencode-proxy.ts \
  /Users/chris/git/hena-agent/oc.hena.dev/auth-proxy/server.ts \
  /absolute/private/staging/reviewed-server.ts
diff -u /Users/chris/git/hena-agent/oc.hena.dev/auth-proxy/server.ts /absolute/private/staging/reviewed-server.ts
```

The adapter matches six reviewed anchors and refuses missing, duplicated or already-patched shapes. Incoming Basic credentials go upstream unchanged, including WebSocket upgrades. A machine 401 **never** retries with the proxy's cached privileged credentials; native OpenCode validates the supplied credential. Existing cookie login still uses the cached native credential. **Initial deployment prerequisite:** at the approved proxy deployment step inspect the full diff, install the reviewed copy and rebuild only the existing proxy, without changing its internal origin networking. Through `https://oc.renai.im`, verify valid machine Basic credentials return native API JSON, invalid credentials return401 without privileged fallback, and SSE, terminals and cookie login still work. Record this verification before any application/bootstrap start or import; do not substitute an internal HTTP URL. Tests exercise HTTP and WebSocket credential forwarding; they do not claim the live public ingress is verified.

## Persona-folder plugins/config installation (ADR-0023)

The upstream mounts `ren-ai-opencode-location` at `/srv/ren-ai:ro`. Keep code,
dependencies and root config read-only. The repository-owned
`opencode.sessions.compose.yml` overlay mounts separate writable volumes at
`/srv/ren-ai/personas` and `/srv/ren-ai/sandboxes`. It changes no proxy, tunnel,
ports, home volume or unrelated location. All of a persona's managed sessions
open `/srv/ren-ai/personas/<persona-id>`; only operator experiments open Sandbox
folders. Preserve the old sessions volume as rollback evidence during the
[shared-life cutover](shared-life-cutover.md). Do not edit the external Compose
source automatically.

1. After completing the public-HTTPS proxy prerequisite above, inspect inherited plugins with authenticated `ops/session-transfer.ts plugins NEW-inventory.json`, setting `OPENCODE_URL=https://oc.renai.im` and `OPENCODE_DIRECTORY=/srv/ren-ai`. Review each plugin's ID/target/source; create a JSON array of **all unrelated inherited plugin IDs/targets**, including discovered global plugin directory targets. An empty list is appropriate only when inventory proves there are none. OpenCode V2 supports `-target` removal entries, not an invented isolation setting. Native `opencode.config.instruction` and `opencode.config.agent` must remain enabled: the generator strips them from the exclusion list. It always excludes the obsolete `personas` ID and `/srv/ren-ai/plugin` target.

   Initial inventory can be empty while a location initializes. Inspect the loaded location again before treating it as empty. On the deployed 2.0.19 instance, disabling versioned package targets did not disable the loaded plugins; their actual IDs (`henadev.anthropic-auth`, `opencode-discord-noti`, `opencode-translate`) did. Verify those plugins are absent or disabled after reloading the persona location, while ordinary locations retain them.

2. Generate config with `bun ops/location-config.ts REVIEWED-targets.json NEW-opencode.json`. Default callback is `https://api.renai.im/rpc`; override `REN_AI_CALLBACK_URL` only deliberately. Config points at `/srv/ren-ai/plugins/{tools,context,memory,title,dice,session-folder}/src`. OpenCode 2.0.19's local directory loader needs the directory containing `index.js`; the parent package's `main` field is insufficient. Runtime modules receive the root directory and callback URL and read `TOKEN_MANAGEMENT` from the process environment. They resolve the event's session ID through its durable binding, rather than deriving it from a directory name. The folder RPC is registered in the root location. Source declarations and installed platform dependencies remain pinned to OpenCode 2.0.19.
3. Put `opencode.json` in `REN_AI_LOCATION_INPUT`, owner-only. Supply `TOKEN_MANAGEMENT` through the protected environment. During an approved pause, stop intake/scheduling and export stopped volumes before changing an installed location. Select a **new**, empty `REN_AI_LOCATION_VOLUME` and create it explicitly; never overwrite the previous plugin volume. Keep `BOOTSTRAP_ONLY=true` throughout the [cutover](shared-life-cutover.md).
4. Validate `docker compose -f ops/compose.yml config --quiet`, then run `docker compose -f ops/compose.yml --profile tools run --build --rm install-location`. The installer refuses a nonempty volume and creates persona and Sandbox mountpoints. The Worker bundles ground rules as text; Node adapters use `loadGroundRules`.

   Compaction remains `buffer:400000`, `keep.tokens:12000` (1M context / 600k budget), and the app-selected model remains `opencode-go/deepseek-v4.1-flash`. OpenCode triggers compaction at `(limit.input || limit.context) - buffer`: reducing this buffer to 40k would delay compaction to 960k on a 1M window. The embedded test host's 40k buffer belongs to its separate 100k model / 60k budget; it is not the production config's expected value. Re-evaluate the buffer against the resolved model limits when changing the production model.

5. Review the merged external deployment **without starting it** (absolute paths are important; the first Compose file keeps its existing project/env/build context). Full `config` output includes credentials: review privately, never paste it into logs or tickets; use `config --quiet` for ordinary validation.

   ```sh
   docker compose --project-directory "$OC_DEPLOYMENT_DIRECTORY" \
     -f "$OC_DEPLOYMENT_DIRECTORY/docker-compose.yml" \
     -f "$PWD/apps/api/ops/opencode.sessions.compose.yml" config
   ```

   At the approved deployment step, use those same arguments with `up -d --no-deps opencode-upstream`. Keep using the overlay on later starts/recreates. Verify the root mount is read-only and both persona and Sandbox submounts are writable. Existing whole-home, compatibility image, proxy and tunnel settings stay unchanged. The application has none of these mounts. Start its callback in bootstrap mode before migration.

6. Follow [Shared-life cutover](shared-life-cutover.md) for existing ADR-0012 sessions. Preserve native session IDs and history while moving their locations. Restore into a replacement host with the current session archive format only; the one-off cutover is the explicit converter for old data. Keep rollback archives and enable exactly one intake.
7. Verify native agent/instruction loaders and the scoped tools, compaction and retained-session history. Each persona root has `.opencode/agents/<id>.md`, `AGENTS.md`, `persona.json`, `opencode.json`, shared `STATE.md`/`MEMORY.md`/`long-term`, and `conversations/<key>` Relationship scopes. Include hidden bindings and `.memory` execution metadata in backups. Markdown is authoritative; interrupted writes recover through a transient write-ahead record. Catalog refresh changes identity and rules once per persona while preserving live State and Memory. A dedicated location is **not** a security sandbox.

## Messages Mac

The Mac messaging service is a separate package with its own [runbook](../../imsg/ops/README.md): artifact build, installation, tunnel, Fleet permissions and relocation.

## Remote request deadlines

OpenCode's shared client allows up to 30 seconds for response headers and another 30 seconds to decode a finite response body, including native session-folder RPCs. HTTP `session.wait` calls also have a 30-second response-header deadline; expiring a waiter does not interrupt the native Conversation or repeat its model work. Established OpenCode event streams remain open until their scope is cancelled.

The shared Messages client bounds each finite RPC at 30 seconds, including response consumption. Its long-lived `follow` stream retains its scoped lifetime. Executor health and Discord delivery each have a 10-second deadline; cancellation aborts the underlying fetch, and unused webhook response bodies are cancelled. Existing shorter operation deadlines still apply.

A deadline does not prove that a mutation failed before submission. Timed-out sends retain the durable uncertain-send fence and require status reconciliation; the transport does not automatically resend. These per-call limits do not bound an entire alarm's work: the alarm budget and persisted resumption are tracked separately in R03 of [the remediation record](../../../docs/specs/preopen-remediation.md).

## Event-driven execution release (ADR-0019)

The Worker and application plugins must be released together: streaming `wait`, `status` and `sends` RPCs have been replaced by local waiting and a combined finite `context` response. The context request carries the actual model-visible message IDs. Terminal execution notifications use `observe`.

1. Stage the tested Worker and fresh plugin bundles using the session-folder installation procedure above. Preserve the existing plugin volume and export state during the planned pause. api-msg's CI artifact contains its observer; its protected `APPLICATION_API_URL` defaults to `https://api.renai.im` and uses the existing `TOKEN_MANAGEMENT`. Set it explicitly for staging/local operation. Its private environment is not changed by the automatic updater.
2. Put the application in `BOOTSTRAP_ONLY=true`, interrupt/drain active OpenCode execution, and record uncertain sends. Keep Messages receiving. Install the fresh plugin location and recreate OpenCode with that location; retain the writable persona/Sandbox volumes and current State/Memory.
3. Deploy the matching Worker in bootstrap mode, then enable execution. Confirm the installed api-msg revision matches its artifact. Its wake requests may retry while the Worker is paused. Send one authenticated `POST /management/intake/wake` after enabling execution to initialize/catch up intake promptly; a new empty application must establish its initial bookmark before accepting live Conversations.
4. With a marked test Handle, verify burst replies, an interrupted local wait, an edit across a Worker restart, incoming messages received during the pause, scheduled first contact/follow-up, and failed-turn recovery. Confirm an idle alarm is approximately five minutes away and Catalog reads/folder writes do not repeat on actor replacement. Mac outage alerts now use a five-minute safety interval.
5. Check public `/health` identity, exact artifact revision and readiness for api-app, api-msg and imsg. A published artifact or a degraded Worker-only smoke check is not an end-to-end rollout. For rollback, pause first and restore the matching Worker/plugin pair after reconciling send records.

Cloudflare owns all application state. The Mac observer has no application database; on restart it fetches the authoritative bookmark/edit window and resumes observation. A 202 wake response means the wake was scheduled, not that a message was delivered or a persona replied.

## Initial cutover: planned pause, not two intakes

1. Keep the old app running until ready. Stage the [Mac artifact/MDM](../../imsg/ops/README.md), Docker images and secrets. **Before starting the new application, even in bootstrap mode, apply/review the machine-Basic proxy adapter and verify valid/invalid authenticated native API access through public `https://oc.renai.im` plus existing browser/SSE/terminal behavior.** Only then stage reviewed plugin inventory/config and proceed to the planned pause. Recheck approved Korean onboarding copy/consent version and provider privacy facts before enabling onboarding. Do not infer renewal of a historical zero-retention agreement.
2. During the approved pause, stop **old intake and scheduling**; settle work or record every pending/uncertain send. Stop its LaunchAgent and confirm no process still holds either database. Leave Apple Messages receiving. Export existing target Docker volumes as a rollback backup only during their own separately approved stop; never replace that home during the initial session import.
3. `CONFIRM_SOURCE_STOPPED=yes bash ops/snapshot-legacy.sh OLD-STATE NEW-SNAPSHOT` preserves complete application state, bookmarks/bindings/send records, plus coherent `server.sqlite` and `opencode.sqlite` copies. No original database writes. This tooling requires the original state tree, not the old GET-only viewer.
4. `bash ops/export-legacy.sh NEW-SNAPSHOT OLD-PERSONA-DIRECTORY` runs the pinned native 2.0.19 core/server **only inside a network-disabled one-off image** against a throwaway copy. It exports through native HTTP route APIs without opening a listener, invoking a restart sweep, calling the model, or loading the old plugin. Native schema migrations may update only that disposable copy. Review fidelity against stopped 2.0.16 snapshots before cutover; keep original snapshots unchanged. `sessions.json` includes all sessions in the old location (active, retained resets/removals and children) and pending user/synthetic inbox data.
5. The historical `install-application-state.sh` copies a stopped snapshot to an empty archival volume only. It is not a Worker import. Use the coordinated read-only export and empty Durable Object import described above; do not start another local SQLite writer. Keep the Worker bootstrap-only while reviewing IDs/bookmarks and uncertain sends.
6. These initial relocation notes are historical. Use the checkout matching an old archive when restoring it, then follow the [ADR-0023 cutover](shared-life-cutover.md). Current `session-transfer.ts restore` consumes the current persona-scoped archive, restores each persona scope once, preserves native IDs and imports parents before children. Native 2.0.19 import omits fork/revert metadata; those archives require full OpenCode home-volume restore. Pending work stays queued with `resume:false`. Existing sessions are never overwritten; inspect partial target IDs before retrying an import.
7. Verify session/message/tool history, retained sessions, app bindings, plugin policy, both public authenticated endpoints, native cookie/machine/UI flows, and Messages attachment/status/read/typing/reaction behavior. Reconcile physical-send uncertainty against Messages history; **never retry an uncertain send just because it is absent from imported session memory**. Pending control operations must be drained/settled before migration, not silently dropped.
8. Explicitly restart the app with `BOOTSTRAP_ONLY=false` only after verification. Recovery activates imported pending inbox work through supported APIs, intake catches up Messages history and GUID deduplication prevents replay. Verify messages received during the pause, scheduling and delivery reconciliation with a marked test Handle, not personal conversations.
9. Only after acceptance retire the old `dev.hena.ren-ai`, old log agent, viewer-only asset LaunchAgent/listeners 4700/4701/47987 and the old Tailscale8447 mapping. Do not delete snapshots or unrelated Keychain items. Old source is rollback evidence, not a second active intake. Rollback after any new physical send requires reviewing both sides' send records before resuming the old app.

## Offline scoped export

Current offline exports use the version-2 persona-scoped archive. Supply a stopped
OpenCode database at `/snapshot/opencode.sqlite` and make a complete stopped copy
of the recorded managed root available at that same absolute path inside the
export container. The root must include `personas/` (including `.bindings`, each
persona's `.sessions`, State, Life memory and Conversation scopes) and `sandboxes/`.
Keep the plugin-location, persona and Sandbox mount layout together when copying
or restoring these scopes. A database-only copy cannot produce this archive.

Run `ops/offline-export.ts RECORDED-MANAGED-ROOT` in the network-disabled migration
image with `/output` pointing at a new protected output directory. It copies the
database into `/scratch`, reads existing validated bindings and snapshots from
the copied scopes, and writes `/output/sessions.json` exclusively. The embedded
native routes use `project:false`; no plugin lifecycle, adoption, session moves,
restart sweep or model execution runs. Missing scopes or incoherent native
locations fail the export. Preserve the original database and scope backups;
restore their recorded mounts before retrying. Legacy version-1 sources require
the explicit ADR-0023 cutover, not an export fallback.

## Independent future relocation

**Mac:** follow [Relocate to another Mac](../../imsg/ops/README.md#relocate-to-another-mac). Docker services and OpenCode credentials stay untouched.

**Docker:** stop all consumers of the **six** exported volumes, including OpenCode
and its cookie proxy. `ops/export-docker.sh` refuses running mounts and captures
whole OpenCode home, proxy state, plugin location, archived application state,
persona roots and Sandboxes, plus the reviewed deployment/configuration. Set
`REN_AI_PERSONA_VOLUME` and `REN_AI_SANDBOX_VOLUME` consistently for Compose and
backup/restore. Old five-volume backups belong to ADR-0012 and require its
matching restore tooling followed by the explicit cutover. Full-home backup
preserves native fork metadata and unrelated projects; scoped native exports do
not replace it. Preserve Fleet state using its own backup tooling.

On the replacement host, `ops/restore-docker.sh VERIFIED-BACKUP NEW-CONFIG-DIRECTORY`
verifies checksums and restores into **new, nonexistent** volumes without starting
services. Apply the restored overlay and verify writable persona and Sandbox
mounts. Keep the callback bootstrap-only while checking native IDs, current
documents, bindings, plugin policy, public authentication and Mac integration.
Verify exact artifact revisions and readiness before switching traffic to the
stable public addresses. Reconcile uncertain sends and pause-period intake,
activate exactly one intake, then retire the old host. Keep backups and
credentials together under access control.

## Verification scope

Repo tests prove the transfer and service contracts; operation tests exercise native snapshot exports, pagination, artifact graph rejection and proxy credential behavior. Validate scripts with `bash -n` and Compose with configured staging values. Image builds and private artifact/installer checks are safe before live deployment. Actual PPPC delivery, public hostname routing, old-version snapshot fidelity and native UI/model behavior require the attended staged checks above; they are not claimed complete by source tests.

After changing runtime plugins, build the plugin image and run the compiled-plugin regression harness with the separate plugin-directory artifact layout. Its default path exercises cold activation and folder RPCs inside the compiled CLI using isolated fake services; `--preprovisioned` is only a debugging fallback. The former `/artifact/plugin` layout is obsolete. Cross-instance schema failures can escape embedded-runtime tests: keep every folder RPC input/output/error/event schema and the positive-number `wait` input behind opaque Standard Schema boundaries. Void folder operations return JSON `null` on the wire. `COMPILED_OPENCODE_IMAGE` can select the pinned CLI image when the local compatibility image is unavailable.

From the repository root, with Bun 1.4.2, run `COMPILED_PLUGIN_IMAGE=ren-ai/plugin:local bun apps/api/test/compiled-plugin/regression.mjs`. The harness builds that plugin image; `--artifact-only` uses an already built image. It also verifies finite context responses, local wait deadlines and interruption by admitted input, and the absence of `wait`, `status` and `sends` RPC calls.
