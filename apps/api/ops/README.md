# Separate application, OpenCode, and Messages deployments

## Cloudflare application and controlled cutover

`@ren-ai/api-app` is the stateful Worker at `https://api-app.renai.im`;
`@ren-ai/api-msg` is the DB-free Mac executor at `https://api.renai.im`.
The executor forwards to `https://oc.renai.im` and
`https://imsg.renai.im/rpc`. Discovery registration and Admin management use
api-app; Discovery also reads its public profiles through api-app, which requests
the current public Catalog from Admin on every read.

Local `bun dev` serves api-app at `http://127.0.0.1:4879` and its Wrangler
debugger at `http://127.0.0.1:5879`. Export `API_APP_PORT` or
`API_APP_INSPECTOR_PORT` to override these process-level settings.

The root `bun dev` starts both api-app and api-msg. api-app loads the checked-in
`.env.development` and connects to `http://127.0.0.1:4700` with the matching
local `TOKEN_MANAGEMENT`. Private `.dev.vars` overrides these Worker bindings.
Bootstrap mode remains enabled until explicitly configured for execution.

CI deploys api-app only from `main` after every quality gate, then probes its
safe health and public Catalog endpoints. Its first deployment must remain
bootstrap-only, with intake and background scheduling disabled. Do not enable
intake while the old application is accepting registrations. During a planned
pause, stop old intake/scheduling, settle or record uncertain sends, take a
read-only export of the old SQLite state, and import it into an empty Worker
store. Verify IDs, assignments, bookmarks, pending work and uncertain sends
before enabling the new intake. Preserve the stopped container and volume for
rollback. No script changes live ingress, stops a service or enables intake.

After old intake and scheduling are stopped, create an owner-only private archive:

```sh
# state:export runs Node 24 (node:sqlite URI support preserves readonly WAL reads).
CONFIRM_APPLICATION_STOPPED=yes bun run state:export /private/path/server.sqlite /private/path/new-state.json
API_APP_URL=https://api-app.renai.im bun run state:import /private/path/new-state.json
```

Load `TOKEN_MANAGEMENT` from a protected environment. The exporter opens the
source read-only and exclusively creates a mode-0600 JSON archive. Import is
authenticated at `POST /management/state/import`, works only in bootstrap mode,
and atomically restores into an empty application database. Repeating the same
archive is idempotent; a different archive, incompatible columns or nonempty
target is rejected. `GET /management/state/export` is an authenticated private
verification snapshot. Archives contain handles and conversation text: keep
them out of Git/logs and preserve IDs, bookmarks and uncertain sends.

Copy `apps/api/.dev.vars.example` to `.dev.vars` for local Worker development.
`bun run dev` listens on `API_APP_PORT` (default 4879). Local state belongs to
Wrangler's DO persistence, never a running Mac `server.sqlite`. Bootstrap is
enabled by default; after the explicit import and native executor verification,
change `BOOTSTRAP_ONLY` to `false` through a reviewed PR. SQLite DO point-in-time
recovery replaces the retired local nightly database snapshots; OpenCode's
session documents remain in the existing OpenCode storage and exports.

Reuse api-app's existing private `TOKEN_MANAGEMENT` secret and
`API_MSG_URL=https://api.renai.im`. Provision the Mac executor once through
the current Mac deployment procedure: create its separate process, tunnel and
protected environment with the same `TOKEN_MANAGEMENT`, plus `OPENCODE_URL`,
`OPENCODE_AUTHORIZATION`, `IMSG_URL` and `IMSG_TOKEN`. It has no Turnstile secret
or local application database. Thereafter the Mac consumes the attested bundle
published from `main`; it does not receive a manual deploy or alter the native
imsg protocol.

## Discovery and Admin

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
API_APP_URL=https://api-app.renai.im bun run operator remove HANDLE
```

The commands are `remove`, `block`, `rebuild`, `test-handle` and `untest-handle`,
each taking one handle.

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
4. Delete the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository
   secrets; no workflow uses them.

## Move to renai.im

[ADR-0016](../../../docs/adr/0016-the-service-lives-at-renai-im-in-one-cloudflare-account.md)
moves every hostname except `fleet.hena.dev` into the Ambivalent Co. account. Retire
the old test site first; with no live conversations left, the move is one planned
pause.

Before merging:

1. In the Ambivalent Co. account, provision the Mac executor tunnel for
   `api.renai.im`, plus the existing Mac endpoints:
   - `api.renai.im` → the separately provisioned executor listener
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

5. Merge. CI deploys Admin, Discovery and api-app after quality gates; api-app
   initially remains bootstrap-only.
6. On the Messages Mac, follow [Move to imsg.renai.im](../../imsg/ops/README.md#move-to-imsgrenaiim).
7. In the external OpenCode Compose project, replace the tunnel token with the
   `oc.renai.im` tunnel's and recreate only that tunnel container. Sign in again at
   `https://oc.renai.im`.
8. Provision api-msg process/tunnel and protected environment once. Set
   `TOKEN_MANAGEMENT`, `API_MSG_URL`, `OPENCODE_URL`, `OPENCODE_AUTHORIZATION`,
   `IMSG_URL` and `IMSG_TOKEN`; do not put `TURNSTILE_SECRET` or application DB
   settings on the Mac. The Mac automatically installs the attested `main`
   bundle. Install a plugin location whose callback is
   `https://api-app.renai.im/rpc`.
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

Before rollout, inspect live `user`/`conversation` persona assignments. Duplicate
live assignments stop application startup and need explicit operator resolution.
No conversations are automatically deleted. Migration 019 creates the durable
assignment/selection/contact tables. Operator removal and test reset release
assignments. Failed, blocked, unreachable and uncertain first contacts keep
their reservation until the operator resolves/removes them.

Selection and its 5–60 minute schedule commit together. The worker records a
session ID before creating its native folder, and records the Conversation
before enqueueing the Greeting with a stable inbox ID. Restart continues untouched due reservations and observes existing
preparations/sends without submitting a second Greeting. An interrupted or
uncertain attempt requires inspection; send failures and iMessage absence are
distinct from observed success. Request/task diagnostics are JSON with request
IDs and sanitized causes, excluding handles, tokens, private persona text and
message content.

Admin management uses `APPLICATION_API_URL=https://api-app.renai.im` and
`TOKEN_MANAGEMENT`; Discovery registration uses
`VITE_DISCOVERY_API_URL=https://api-app.renai.im`. Discovery profile reads use
api-app's `/discovery/personas`; the browser does not bind D1 or run a catalog API.

No script below performs the live cutover, stops existing services, changes an existing Cloudflare ingress, or edits the external OpenCode deployment. Install/restore refuse existing destinations. Run scripts with `bash`; TypeScript edges run with Bun 1.4.2 from a dependency-installed checkout. Treat exported archives as private: they contain conversations and service credentials. Encrypt and copy backups off-host yourself; no paid service is required.

## Services and credentials

| Service     | Runtime                                                            | Persistent state                                                                                            | Ingress / auth                                                              |
| ----------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Messages    | [Native Mac GUI LaunchAgent](../../imsg/ops/README.md), Bun + imsg | Apple Messages; dedicated messaging token                                                                   | `imsg.renai.im` → loopback 4702, Cloudflare Tunnel; Bearer                  |
| Application | `@ren-ai/api-app` Cloudflare Worker                                | SQLite-backed application Durable Object; remote Admin D1 Catalog                                           | `api-app.renai.im`; plugin callback Bearer                                  |
| Executor    | `@ren-ai/api-msg` Bun process on the Mac                           | None                                                                                                        | `api.renai.im` → Mac; `TOKEN_MANAGEMENT`                                    |
| OpenCode    | Existing `ghcr.io/anomalyco/opencode:2.0.19`                       | Whole `oc-hena-dev_opencode-home`, proxy signing state, read-only plugin location, writable session folders | `oc.renai.im`; native Basic for machines, existing cookie flow for browsers |
| Fleet       | Separate [MDM tooling](../../imsg/ops/mdm/README.md)               | Fleet database, certificates and secrets                                                                    | `fleet.hena.dev`                                                            |

The following host-relocation notes describe the prior Docker application deployment and are retained only for archived backup/rollback work. They do not provision or deploy api-app or api-msg. For the current Mac executor setup, use [api-msg provisioning](../../api-msg/ops/README.md). The current executor uses the existing OpenCode upstream through authenticated public `https://oc.renai.im`; do not alter its tunnel or proxy for api-msg.

The inspected Alpine/aarch64 OpenCode 2.0.19 image needs `gcompat=1.1.0-r4` and `LD_PRELOAD=/lib/libgcompat.so.0` for its bundled PTY library. Without both, terminal creation fails with `gnu_get_libc_version: symbol not found`. The deployed external Compose file includes a `compat/Dockerfile` with this same-version fix; preserve it during relocation. The OpenCode executable is unchanged. Verify a ticketed WebSocket shell roundtrip, not only the UI or `/api/info`.

The removed `application.env.example` applied to the old Docker application. For the executor's minimal protected environment, use [`api-msg.env.example`](../../api-msg/ops/api-msg.env.example): it reuses `TOKEN_MANAGEMENT`, native `OPENCODE_AUTHORIZATION`, and existing `IMSG_TOKEN`. The Mac needs no Turnstile secret, application database or provider credential.

Compose variables: `REN_AI_APP_ENV` (absolute protected env file), `REN_AI_TUNNEL_TOKEN` (application tunnel), `REN_AI_LOCATION_INPUT` (absolute reviewed plugin config/token staging directory). Volume names are overridable through `REN_AI_STATE_VOLUME`, `REN_AI_LOCATION_VOLUME`, `REN_AI_SESSION_VOLUME`. The application never mounts either OpenCode volume; session-folder writes use authenticated public plugin RPC.

The Catalog is the Admin Worker's Drizzle/D1 database and starts empty. Set
`PERSONA_CATALOG_URL` and `TOKEN_CATALOG` in the protected application
env file; the token matches the Worker's `TOKEN_CATALOG`. There is no file mount
or seed-copy step. See [Admin deployment](../../../apps/admin/README.md).
The application polls revisions and synchronizes native folders. Publish new
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

## Session-folder plugins/config installation (ADR-0012)

The upstream already mounts the reserved `ren-ai-opencode-location` volume at `/srv/ren-ai:ro`. Keep code, dependencies, root config and token read-only. The repository-owned `opencode.sessions.compose.yml` overlay retains that mount and adds **only** a new writable volume at `/srv/ren-ai/sessions` to `opencode-upstream`; it changes no proxy, tunnel, ports, home volume or unrelated location. Do not edit the external Compose source automatically.

1. After completing the public-HTTPS proxy prerequisite above, inspect inherited plugins with authenticated `ops/session-transfer.ts plugins NEW-inventory.json`, setting `OPENCODE_URL=https://oc.renai.im` and `OPENCODE_DIRECTORY=/srv/ren-ai`. Review each plugin's ID/target/source; create a JSON array of **all unrelated inherited plugin IDs/targets**, including discovered global plugin directory targets. An empty list is appropriate only when inventory proves there are none. OpenCode V2 supports `-target` removal entries, not an invented isolation setting. Native `opencode.config.instruction` and `opencode.config.agent` must remain enabled: the generator strips them from the exclusion list. It always excludes the obsolete `personas` ID and `/srv/ren-ai/plugin` target.

   Initial inventory can be empty while a location initializes. Inspect the loaded location again before treating it as empty. On the deployed 2.0.19 instance, disabling versioned package targets did not disable the loaded plugins; their actual IDs (`henadev.anthropic-auth`, `opencode-discord-noti`, `opencode-translate`) did. Verify those plugins are absent or disabled after reloading the persona location, while ordinary locations retain them.

2. Generate config with `bun ops/location-config.ts REVIEWED-targets.json NEW-opencode.json`. Default callback is `https://api-app.renai.im/rpc`; override `REN_AI_CALLBACK_URL` only deliberately. Config points at each bundle's entry directory: `/srv/ren-ai/plugins/{tools,context,memory,title,session-folder}/src`. OpenCode 2.0.19's local directory loader needs the directory containing `index.js`; the parent package's `main` field is insufficient. Runtime modules receive `directory:/srv/ren-ai` and the callback URL, and read the existing `TOKEN_MANAGEMENT` from the OpenCode process environment; they run only for direct session descendants. Session-folder needs only `directory` and registers RPC in the root location. Compaction remains `buffer:400000`, `keep.tokens:12000` (1M context / 600k budget), and the app-selected model remains `opencode-go/deepseek-v4.1-flash`. Source declarations and installed platform dependencies stay pinned to OpenCode 2.0.19.
3. Put `opencode.json` in `REN_AI_LOCATION_INPUT`, owner-only. Supply the existing `TOKEN_MANAGEMENT` to the OpenCode process through its protected environment; no separate token file is installed. During an approved pause, stop intake/scheduling and export stopped volumes before changing an installed location. The new exporter requires all five volumes: when upgrading an old four-volume deployment, first provision the new empty sessions volume (`docker volume create "${REN_AI_SESSION_VOLUME:-ren-ai-opencode-sessions}"`) without mounting it into running services, then export with the **old** location volume selected. For an existing old plugin volume, select a **new** `REN_AI_LOCATION_VOLUME` (for example `ren-ai-opencode-location-v2`) and explicitly `docker volume create "$REN_AI_LOCATION_VOLUME"`; never overwrite the old volume. Keep the application in `BOOTSTRAP_ONLY=true` while migrating.
4. Validate `docker compose -f ops/compose.yml config --quiet`, then explicitly `docker compose -f ops/compose.yml --profile tools run --build --rm install-location`. The installer refuses a nonempty volume; it installs five separate bundles, pinned dependencies/locks and the session-folder template, protects config/token files, and creates the sessions mountpoint. The Worker bundles its ground rules as text; Node story adapters load the private template with `loadGroundRules`. No plugin constructs agents.
5. Review the merged external deployment **without starting it** (absolute paths are important; the first Compose file keeps its existing project/env/build context). Full `config` output includes credentials: review privately, never paste it into logs or tickets; use `config --quiet` for ordinary validation.

   ```sh
   docker compose --project-directory "$OC_DEPLOYMENT_DIRECTORY" \
     -f "$OC_DEPLOYMENT_DIRECTORY/docker-compose.yml" \
     -f "$PWD/apps/api/ops/opencode.sessions.compose.yml" config
   ```

   At the approved deployment step, use those same arguments with `up -d --no-deps opencode-upstream`. Keep using the overlay on later starts/recreates. Verify the root mount is read-only and the sessions submount is writable; existing whole-home, compatibility image, proxy and tunnel settings must be unchanged. The application has neither mount. Start its callback in bootstrap mode before migration.

6. With old intake stopped and bootstrap confirmed, **interrupt/drain active execution and queued inbox work** for all sessions to move. Run `CONFIRM_BOOTSTRAP_ONLY=yes bun ops/session-transfer.ts folders /absolute/private/NEW-pre-cutover-archive.json` using protected `OPENCODE_URL`, `OPENCODE_AUTHORIZATION` and `OPENCODE_DIRECTORY=/srv/ren-ai`. If source definitions are needed, supply `PERSONA_CATALOG_URL` and `TOKEN_CATALOG`; missing IDs fail rather than loading files. The command exclusively creates the archive and skips already-moved sessions. Review partial results and use a new archive path before retrying. Exports include persona/agent/rules and current Conversation documents; restore recreates folders before importing. Preserve rollback archives and never enable a second intake.
7. Inspect root and session-location inventories. Verify obsolete `personas` is absent, no unrelated inherited plugin remains, native agent/instruction loaders are enabled, and each session has `.opencode/agents/<id>.md`, `AGENTS.md`, `persona.json`, and `opencode.json` with `default_agent` and disabled `build`/`plan`/`general`/`explore`. Verify only send/read/react/wait/dice and update_state/update_memory/remember/search_memory, compaction, ordinary project writes, native UI features and retained-session history. Runtime memory writes publish `.memory/current`; include hidden revisions and symlinks in volume backups. Active Persona/ground-rule snapshots refresh at startup/catalog change; current State/Memory and retained snapshots do not reset. A dedicated location is **not** a security sandbox.

## Messages Mac

The Mac messaging service is a separate package with its own [runbook](../../imsg/ops/README.md): artifact build, installation, tunnel, Fleet permissions and relocation.

## Initial cutover: planned pause, not two intakes

1. Keep the old app running until ready. Stage the [Mac artifact/MDM](../../imsg/ops/README.md), Docker images and secrets. **Before starting the new application, even in bootstrap mode, apply/review the machine-Basic proxy adapter and verify valid/invalid authenticated native API access through public `https://oc.renai.im` plus existing browser/SSE/terminal behavior.** Only then stage reviewed plugin inventory/config and proceed to the planned pause. Recheck approved Korean onboarding copy/consent version and provider privacy facts before enabling onboarding. Do not infer renewal of a historical zero-retention agreement.
2. During the approved pause, stop **old intake and scheduling**; settle work or record every pending/uncertain send. Stop its LaunchAgent and confirm no process still holds either database. Leave Apple Messages receiving. Export existing target Docker volumes as a rollback backup only during their own separately approved stop; never replace that home during the initial session import.
3. `CONFIRM_SOURCE_STOPPED=yes bash ops/snapshot-legacy.sh OLD-STATE NEW-SNAPSHOT` preserves complete application state, bookmarks/bindings/send records, plus coherent `server.sqlite` and `opencode.sqlite` copies. No original database writes. This tooling requires the original state tree, not the old GET-only viewer.
4. `bash ops/export-legacy.sh NEW-SNAPSHOT OLD-PERSONA-DIRECTORY` runs the pinned native 2.0.19 core/server **only inside a network-disabled one-off image** against a throwaway copy. It exports through native HTTP route APIs without opening a listener, invoking a restart sweep, calling the model, or loading the old plugin. Native schema migrations may update only that disposable copy. Review fidelity against stopped 2.0.16 snapshots before cutover; keep original snapshots unchanged. `sessions.json` includes all sessions in the old location (active, retained resets/removals and children) and pending user/synthetic inbox data.
5. The historical `install-application-state.sh` copies a stopped snapshot to an empty archival volume only. It is not a Worker import. Use the coordinated read-only export and empty Durable Object import described above; do not start another local SQLite writer. Keep the Worker bootstrap-only while reviewing IDs/bookmarks and uncertain sends.
6. Install/verify the plugin location and sessions overlay with the callback alive. Use `CONFIRM_BOOTSTRAP_ONLY=yes bun ops/session-transfer.ts restore NEW-SNAPSHOT/sessions.json` against the existing OpenCode. Restore checks the complete archive and target IDs, refuses collisions/cycles/control work and fork/revert metadata, preserves IDs, creates folders before import and imports parents first. Modern archives carry persona/agent/rules and Conversation document snapshots. If an archive needs definitions, supply the authenticated Catalog connection; missing IDs fail. For root sessions, use the paused `session-transfer.ts folders NEW-ARCHIVE.json` command after draining execution and inbox work. Native2.0.19 import omits fork/revert information; such archives require a full OpenCode home-volume restore. Pending work is queued with `resume:false`, including inline images. Existing sessions are never overwritten. Inspect partial target IDs before retrying an import.
7. Verify session/message/tool history, retained sessions, app bindings, plugin policy, both public authenticated endpoints, native cookie/machine/UI flows, and Messages attachment/status/read/typing/reaction behavior. Reconcile physical-send uncertainty against Messages history; **never retry an uncertain send just because it is absent from imported session memory**. Pending control operations must be drained/settled before migration, not silently dropped.
8. Explicitly restart the app with `BOOTSTRAP_ONLY=false` only after verification. Recovery activates imported pending inbox work through supported APIs, intake catches up Messages history and GUID deduplication prevents replay. Verify messages received during the pause, scheduling and delivery reconciliation with a marked test Handle, not personal conversations.
9. Only after acceptance retire the old `dev.hena.ren-ai`, old log agent, viewer-only asset LaunchAgent/listeners 4700/4701/47987 and the old Tailscale8447 mapping. Do not delete snapshots or unrelated Keychain items. Old source is rollback evidence, not a second active intake. Rollback after any new physical send requires reviewing both sides' send records before resuming the old app.

## Independent future relocation

**Mac:** follow [Relocate to another Mac](../../imsg/ops/README.md#relocate-to-another-mac). Docker services and OpenCode credentials stay untouched.

**Docker:** at an approved pause stop all consumers of the **five** exported volumes, including both OpenCode upstream and cookie proxy. `OC_DEPLOYMENT_DIRECTORY=… REN_AI_TUNNEL_TOKEN=… bash ops/export-docker.sh NEW-PRIVATE-BACKUP` refuses running mounts and captures **whole home** (all locations/sessions/provider credentials/projects), proxy data (browser cookie signing identity), read-only persona location (plugins/config/token/dependencies/templates), application state, and writable session folders (agents/instructions/persona snapshots/session configs). It also copies the external Compose/source/env read-only, the sessions overlay, external catalog, application env and separate application tunnel token. Restore supplies the latter as protected `application-tunnel.token`; read it into the Compose environment without logging it. Set custom location/session volume variables consistently for both Compose and export/restore. These five-volume archives are the ADR-0012 format; older four-volume backups need attended migration, not a silent empty session volume. Fleet database/certificates/secrets are exported separately by its tooling; restore them as part of a complete Docker-host move. Full-home restore preserves native fork/revert metadata and all unrelated OpenCode locations; scoped session exports are not a full-host backup.

On the new host, `bash ops/restore-docker.sh VERIFIED-BACKUP NEW-CONFIG-DIRECTORY` verifies checksums and restores into **new, nonexistent** named volumes; it never merges databases or starts containers. Default volume names match the current OpenCode project. Include restored `opencode.sessions.compose.yml` after the external base Compose file and review both volume names; never start a restored stack without its writable sessions submount. Review catalog/env host paths, retain the verified Basic-compatible proxy, and verify the restored public HTTPS OpenCode endpoint before application/bootstrap start or import. Start the callback/application in bootstrap mode and verify plugin/catalog/session counts, native UI/cookie/Basic/SSE/terminal operation and public Mac integration before moving production traffic. Review image architecture/version and keep `https://oc.renai.im` across hosts; use a protected staging HTTPS hostname when checking a replacement before switching the stable route. Do not invent a private HTTP/shared-filesystem or Tailscale dependency. Activate intake only once, reconcile uncertain sends and pause-period messages, then retire the old Docker host. Keep application/OC/Fleet backups and credentials together under access control.

## Verification scope

Repo tests prove the transfer and service contracts; operation tests exercise native snapshot exports, pagination, artifact graph rejection and proxy credential behavior. Validate scripts with `bash -n` and Compose with configured staging values. Image builds and private artifact/installer checks are safe before live deployment. Actual PPPC delivery, public hostname routing, old-version snapshot fidelity and native UI/model behavior require the attended staged checks above; they are not claimed complete by source tests.

After changing runtime plugins, build the plugin image and run the compiled-plugin regression harness with the separate plugin-directory artifact layout. Its default path exercises cold activation and folder RPCs inside the compiled CLI using isolated fake services; `--preprovisioned` is only a debugging fallback. The former `/artifact/plugin` layout is obsolete. Cross-instance schema failures can escape embedded-runtime tests: keep every folder RPC input/output/error/event schema and the positive-number `wait` input behind opaque Standard Schema boundaries. Void folder operations return JSON `null` on the wire. `COMPILED_OPENCODE_IMAGE` can select the pinned CLI image when the local compatibility image is unavailable.
