# Separate application, OpenCode, and Messages deployments

## Discovery domain cutover

`discovery.ambivalent.dev` is an additional swipe/waitlist app in `apps/discovery`,
deployed with Cloudflare Workers Builds. `admin.ambivalent.dev` is the Catalog and
authoring Worker in `apps/admin`. The existing `discovery.hena.dev` site and its
GitHub Actions deployment remain active. See the [Discover setup](../../../apps/discovery/README.md)
and [Admin setup](../../../apps/admin/README.md#workers-builds).
Deploy the `/discovery/` API's additional CORS origin and allow the new hostname
in Turnstile before deploying Discover. Retain the old widget hostname and
onboarding API origin. Point the application at `https://admin.ambivalent.dev` with
the matching private Catalog token; changing the website does not redeploy the
application.

The site is `discovery.hena.dev` in `packages/discovery.hena.dev`, served by the `discovery-hena-dev` Worker. The former `msg-hena-dev` Worker and its `msg.hena.dev` domain are retired without a redirect. The existing Turnstile widget now permits only `discovery.hena.dev`.

For a future domain move, deploy the API's new CORS origin and update Turnstile before deploying the website. Verify HTTPS, `/`, `/privacy`, and browser access to `/onboarding` and `/waitlist` before retiring the old Worker, custom-domain/DNS binding, and CORS origin. Build with the production `VITE_TURNSTILE_SITE_KEY`; main auto-deploys the site. `ops/deploy.sh` is for bootstrap-only migration, not a routine API update.

For persona selection, deploy the API/catalog before the site when possible. If an older API returns 404 for `/personas`, the new site still offers the handle form and omits `personaID`, preserving that API's default persona. Server and network errors show catalog retry instead; they never enable legacy onboarding or offer fabricated profiles.

The generated route file's three exception paths move with the package; their reasons and dates stay unchanged. Changes to `quality-exceptions.json` require the human CODEOWNER's review.

## Service deployment and relocation

### Discovery selection and first contact

The normal application listener serves `/discovery/personas` and
`/discovery/waitlist` alongside the existing onboarding and plugin callback.
The management routes `/management/discovery` (GET) and
`/management/discovery/select` (POST) require `TOKEN_MANAGEMENT`, matching
Admin's `TOKEN_MANAGEMENT`. Keep this credential separate from `TOKEN_CATALOG`,
messaging and plugin tokens. Configure the Admin Catalog at
`https://admin.ambivalent.dev` and retain the application SQLite volume.

Before rollout, inspect live `user`/`conversation` persona assignments. The new
one-persona/one-user policy also applies to legacy onboarding; duplicate live
assignments stop application startup and need explicit operator resolution.
No conversations are automatically deleted. Migration 019 creates the durable
assignment/selection/contact tables. Operator removal and test reset release
assignments. Failed, blocked, unreachable and uncertain first contacts keep
their reservation until the operator resolves/removes them.

Selection and its 5–60 minute schedule commit together. The worker records a
session ID before creating its native folder, and records the Conversation
before enqueueing the Greeting with a stable inbox ID. It sends no separate
Notice. Restart continues untouched due reservations and observes existing
preparations/sends without submitting a second Greeting. An interrupted or
uncertain attempt requires inspection; send failures and iMessage absence are
distinct from observed success. Request/task diagnostics are JSON with request
IDs and sanitized causes, excluding handles, tokens, private persona text and
message content.

Deploy the updated API, set the matching Admin secret, deploy Admin, then
rebuild Discovery with `VITE_DISCOVERY_API_URL=https://api-msg.hena.dev`.
Retain the existing site's CORS origin and add `discovery.ambivalent.dev` to the
existing production Turnstile widget.

No script below performs the live cutover, stops existing services, changes an existing Cloudflare ingress, or edits the external OpenCode deployment. Install/restore refuse existing destinations. Run scripts with `bash`; TypeScript edges run with Bun 1.4.2 from a dependency-installed checkout. Treat exported archives as private: they contain conversations and service credentials. Encrypt and copy backups off-host yourself; no paid service is required.

## Services and credentials

| Service     | Runtime                                                                     | Persistent state                                                                                            | Ingress / auth                                                                        |
| ----------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Messages    | [Native Mac GUI LaunchAgent](../../imsg.hena.dev/ops/README.md), Bun + imsg | Apple Messages; dedicated messaging token                                                                   | `imsg.hena.dev` → loopback 4702, Cloudflare Tunnel; Bearer                            |
| Application | `application` Docker image                                                  | `ren-ai-application-state`; remote Admin D1 Catalog                                                         | `api-msg.hena.dev` → `http://api-msg:4700`, Cloudflare Tunnel; plugin callback Bearer |
| OpenCode    | Existing `ghcr.io/anomalyco/opencode:2.0.19`                                | Whole `oc-hena-dev_opencode-home`, proxy signing state, read-only plugin location, writable session folders | `oc.hena.dev`; native Basic for machines, existing cookie flow for browsers           |
| Fleet       | Separate [MDM tooling](../../imsg.hena.dev/ops/mdm/README.md)               | Fleet database, certificates and secrets                                                                    | `fleet.hena.dev`                                                                      |

The initial target is the **existing OrbStack OpenCode on this Mac**, not a new OpenCode server or a physical move. Its external Compose source is `/Users/chris/git/hena-agent/oc.hena.dev/docker-compose.yml` (user-owned, not a Git repository). Preserve its upstream/proxy/tunnel, persistent whole home and existing sessions. The app uses authenticated public **`https://oc.hena.dev` from the initial deployment**, even on this same Mac; apply and verify the machine-Basic proxy adapter **before starting the application, bootstrap mode, or session import**. The existing internal proxy→upstream origin networking stays unchanged. The application does not join the private OpenCode network or bypass its public HTTPS ingress. No Tailscale dependency or read-only UI remains.

The inspected Alpine/aarch64 OpenCode 2.0.19 image needs `gcompat=1.1.0-r4` and `LD_PRELOAD=/lib/libgcompat.so.0` for its bundled PTY library. Without both, terminal creation fails with `gnu_get_libc_version: symbol not found`. The deployed external Compose file includes a `compat/Dockerfile` with this same-version fix; preserve it during relocation. The OpenCode executable is unchanged. Verify a ticketed WebSocket shell roundtrip, not only the UI or `/api/info`.

Copy `application.env.example` to a protected path outside Git. Set its secrets from the existing deployment; `OPENCODE_AUTHORIZATION` is the complete native `Basic …` header, not a made-up token. The app has **no provider credential**; keep existing provider credentials in OpenCode's preserved home. The Mac has **only** `IMSG_TOKEN` plus its independent Cloudflare Tunnel credential, never app/OpenCode/provider secrets.

Compose variables: `REN_AI_APP_ENV` (absolute protected env file), `REN_AI_TUNNEL_TOKEN` (application tunnel), `REN_AI_LOCATION_INPUT` (absolute reviewed plugin config/token staging directory). Volume names are overridable through `REN_AI_STATE_VOLUME`, `REN_AI_LOCATION_VOLUME`, `REN_AI_SESSION_VOLUME`. The application never mounts either OpenCode volume; session-folder writes use authenticated public plugin RPC.

The Catalog is the Admin Worker's Drizzle/D1 database and starts empty. Set
`PERSONA_CATALOG_URL` and `TOKEN_CATALOG` in the protected application
env file; the token matches the Worker's `TOKEN_CATALOG`. There is no file mount
or seed-copy step. See [Admin deployment](../../../apps/admin/README.md).
The application polls revisions and synchronizes native folders. Publish new
personas before onboarding; any default must be an actual published ID.
Missing IDs preserve existing session snapshots privately. Deploy the updated
session-folder plugin before the application so new Conversations receive
initial State/Memory while updates preserve existing documents.

## Native machine authentication adapter

Generate a **new review copy**, never edit the external source automatically:

```sh
bun packages/api-msg.hena.dev/ops/patch-opencode-proxy.ts \
  /Users/chris/git/hena-agent/oc.hena.dev/auth-proxy/server.ts \
  /absolute/private/staging/reviewed-server.ts
diff -u /Users/chris/git/hena-agent/oc.hena.dev/auth-proxy/server.ts /absolute/private/staging/reviewed-server.ts
```

The adapter matches six reviewed anchors and refuses missing, duplicated or already-patched shapes. Incoming Basic credentials go upstream unchanged, including WebSocket upgrades. A machine 401 **never** retries with the proxy's cached privileged credentials; native OpenCode validates the supplied credential. Existing cookie login still uses the cached native credential. **Initial deployment prerequisite:** at the approved proxy deployment step inspect the full diff, install the reviewed copy and rebuild only the existing proxy, without changing its internal origin networking. Through `https://oc.hena.dev`, verify valid machine Basic credentials return native API JSON, invalid credentials return401 without privileged fallback, and SSE, terminals and cookie login still work. Record this verification before any application/bootstrap start or import; do not substitute an internal HTTP URL. Tests exercise HTTP and WebSocket credential forwarding; they do not claim the live public ingress is verified.

## Session-folder plugins/config installation (ADR-0012)

The upstream already mounts the reserved `ren-ai-opencode-location` volume at `/srv/ren-ai:ro`. Keep code, dependencies, root config and token read-only. The repository-owned `opencode.sessions.compose.yml` overlay retains that mount and adds **only** a new writable volume at `/srv/ren-ai/sessions` to `opencode-upstream`; it changes no proxy, tunnel, ports, home volume or unrelated location. Do not edit the external Compose source automatically.

1. After completing the public-HTTPS proxy prerequisite above, inspect inherited plugins with authenticated `ops/session-transfer.ts plugins NEW-inventory.json`, setting `OPENCODE_URL=https://oc.hena.dev` and `OPENCODE_DIRECTORY=/srv/ren-ai`. Review each plugin's ID/target/source; create a JSON array of **all unrelated inherited plugin IDs/targets**, including discovered global plugin directory targets. An empty list is appropriate only when inventory proves there are none. OpenCode V2 supports `-target` removal entries, not an invented isolation setting. Native `opencode.config.instruction` and `opencode.config.agent` must remain enabled: the generator strips them from the exclusion list. It always excludes the obsolete `personas` ID and `/srv/ren-ai/plugin` target.

   Initial inventory can be empty while a location initializes. Inspect the loaded location again before treating it as empty. On the deployed 2.0.19 instance, disabling versioned package targets did not disable the loaded plugins; their actual IDs (`henadev.anthropic-auth`, `opencode-discord-noti`, `opencode-translate`) did. Verify those plugins are absent or disabled after reloading the persona location, while ordinary locations retain them.

2. Generate config with `bun ops/location-config.ts REVIEWED-targets.json NEW-opencode.json`. Default callback is `https://api-msg.hena.dev/rpc`; override `REN_AI_CALLBACK_URL` only deliberately. Config points at each bundle's entry directory: `/srv/ren-ai/plugins/{tools,context,memory,title,session-folder}/src`. OpenCode 2.0.19's local directory loader needs the directory containing `index.js`; the parent package's `main` field is insufficient. Each runtime module receives `directory:/srv/ren-ai`, the callback URL and `tokenFile:/srv/ren-ai/application.token`; it runs only for direct session descendants. Session-folder needs only `directory` and registers RPC in the root location. Compaction remains `buffer:400000`, `keep.tokens:12000` (1M context / 600k budget), and the app-selected model remains `opencode-go/deepseek-v4.1-flash`. Source declarations and installed platform dependencies stay pinned to OpenCode 2.0.19.
3. Put `opencode.json` and `application.token` (same value as `REN_AI_APPLICATION_TOKEN`) in `REN_AI_LOCATION_INPUT`, owner-only. During an approved pause, stop intake/scheduling and export stopped volumes before changing an installed location. The new exporter requires all five volumes: when upgrading an old four-volume deployment, first provision the new empty sessions volume (`docker volume create "${REN_AI_SESSION_VOLUME:-ren-ai-opencode-sessions}"`) without mounting it into running services, then export with the **old** location volume selected. For an existing old plugin volume, select a **new** `REN_AI_LOCATION_VOLUME` (for example `ren-ai-opencode-location-v2`) and explicitly `docker volume create "$REN_AI_LOCATION_VOLUME"`; never overwrite the old volume. Keep the application in `BOOTSTRAP_ONLY=true` while migrating.
4. Validate `docker compose -f ops/compose.yml config --quiet`, then explicitly `docker compose -f ops/compose.yml --profile tools run --build --rm install-location`. The installer refuses a nonempty volume; it installs five separate bundles, pinned dependencies/locks and the session-folder template, protects config/token files, and creates the sessions mountpoint. The application bundle also carries `templates/ground-rules.md` beside its `src/app.js`, preserving `new URL('../templates/ground-rules.md', import.meta.url)` after bundling. No plugin constructs agents.
5. Review the merged external deployment **without starting it** (absolute paths are important; the first Compose file keeps its existing project/env/build context). Full `config` output includes credentials: review privately, never paste it into logs or tickets; use `config --quiet` for ordinary validation.

   ```sh
   docker compose --project-directory "$OC_DEPLOYMENT_DIRECTORY" \
     -f "$OC_DEPLOYMENT_DIRECTORY/docker-compose.yml" \
     -f "$PWD/packages/api-msg.hena.dev/ops/opencode.sessions.compose.yml" config
   ```

   At the approved deployment step, use those same arguments with `up -d --no-deps opencode-upstream`. Keep using the overlay on later starts/recreates. Verify the root mount is read-only and the sessions submount is writable; existing whole-home, compatibility image, proxy and tunnel settings must be unchanged. The application has neither mount. Start its callback in bootstrap mode before migration.

6. With old intake stopped and bootstrap confirmed, **interrupt/drain active execution and queued inbox work** for all sessions to move. Run `CONFIRM_BOOTSTRAP_ONLY=yes bun ops/session-transfer.ts folders /absolute/private/NEW-pre-cutover-archive.json` using protected `OPENCODE_URL`, `OPENCODE_AUTHORIZATION` and `OPENCODE_DIRECTORY=/srv/ren-ai`. If source definitions are needed, supply `PERSONA_CATALOG_URL` and `TOKEN_CATALOG`; missing IDs fail rather than loading files. The command exclusively creates the archive and skips already-moved sessions. Review partial results and use a new archive path before retrying. Exports include persona/agent/rules and current Conversation documents; restore recreates folders before importing. Preserve rollback archives and never enable a second intake.
7. Inspect root and session-location inventories. Verify obsolete `personas` is absent, no unrelated inherited plugin remains, native agent/instruction loaders are enabled, and each session has `.opencode/agents/<id>.md`, `AGENTS.md`, `persona.json`, and `opencode.json` with `default_agent` and disabled `build`/`plan`/`general`/`explore`. Verify only send/read/react/wait/dice and update_state/update_memory/remember/search_memory, compaction, ordinary project writes, native UI features and retained-session history. Runtime memory writes publish `.memory/current`; include hidden revisions and symlinks in volume backups. Active Persona/ground-rule snapshots refresh at startup/catalog change; current State/Memory and retained snapshots do not reset. A dedicated location is **not** a security sandbox.

## Messages Mac

The Mac messaging service is a separate package with its own [runbook](../../imsg.hena.dev/ops/README.md): artifact build, installation, tunnel, Fleet permissions and relocation.

## Initial cutover: planned pause, not two intakes

1. Keep the old app running until ready. Stage the [Mac artifact/MDM](../../imsg.hena.dev/ops/README.md), Docker images and secrets. **Before starting the new application, even in bootstrap mode, apply/review the machine-Basic proxy adapter and verify valid/invalid authenticated native API access through public `https://oc.hena.dev` plus existing browser/SSE/terminal behavior.** Only then stage reviewed plugin inventory/config and proceed to the planned pause. Recheck approved Korean onboarding copy/consent version and provider privacy facts before enabling onboarding. Do not infer renewal of a historical zero-retention agreement.
2. During the approved pause, stop **old intake and scheduling**; settle work or record every pending/uncertain send. Stop its LaunchAgent and confirm no process still holds either database. Leave Apple Messages receiving. Export existing target Docker volumes as a rollback backup only during their own separately approved stop; never replace that home during the initial session import.
3. `CONFIRM_SOURCE_STOPPED=yes bash ops/snapshot-legacy.sh OLD-STATE NEW-SNAPSHOT` preserves complete application state, bookmarks/bindings/send records, plus coherent `server.sqlite` and `opencode.sqlite` copies. No original database writes. This tooling requires the original state tree, not the old GET-only viewer.
4. `bash ops/export-legacy.sh NEW-SNAPSHOT OLD-PERSONA-DIRECTORY` runs the pinned native 2.0.19 core/server **only inside a network-disabled one-off image** against a throwaway copy. It exports through native HTTP route APIs without opening a listener, invoking a restart sweep, calling the model, or loading the old plugin. Native schema migrations may update only that disposable copy. Review fidelity against stopped 2.0.16 snapshots before cutover; keep original snapshots unchanged. `sessions.json` includes all sessions in the old location (active, retained resets/removals and children) and pending user/synthetic inbox data.
5. `bash ops/install-application-state.sh NEW-SNAPSHOT/application-state` copies the separate application state into an **empty** target application volume without rewriting session IDs/bookmarks or clearing uncertain sends. Start the app with `BOOTSTRAP_ONLY=true` via `CONFIRM_STAGED_DEPLOYMENT=yes bash ops/deploy.sh`: HTTP/callback starts, onboarding is 503, tools reject execution, and no intake/scheduling/recovery/OpenCode calls run.
6. Install/verify the plugin location and sessions overlay with the callback alive. Use `CONFIRM_BOOTSTRAP_ONLY=yes bun ops/session-transfer.ts restore NEW-SNAPSHOT/sessions.json` against the existing OpenCode. Restore checks the complete archive and target IDs, refuses collisions/cycles/control work and fork/revert metadata, preserves IDs, creates folders before import and imports parents first. Modern archives carry persona/agent/rules and Conversation document snapshots. If an archive needs definitions, supply the authenticated Catalog connection; missing IDs fail. For root sessions, use the paused `session-transfer.ts folders NEW-ARCHIVE.json` command after draining execution and inbox work. Native2.0.19 import omits fork/revert information; such archives require a full OpenCode home-volume restore. Pending work is queued with `resume:false`, including inline images. Existing sessions are never overwritten. Inspect partial target IDs before retrying an import.
7. Verify session/message/tool history, retained sessions, app bindings, plugin policy, both public authenticated endpoints, native cookie/machine/UI flows, and Messages attachment/status/read/typing/reaction behavior. Reconcile physical-send uncertainty against Messages history; **never retry an uncertain send just because it is absent from imported session memory**. Pending control operations must be drained/settled before migration, not silently dropped.
8. Explicitly restart the app with `BOOTSTRAP_ONLY=false` only after verification. Recovery activates imported pending inbox work through supported APIs, intake catches up Messages history and GUID deduplication prevents replay. Verify messages received during the pause, scheduling and delivery reconciliation with a marked test Handle, not personal conversations.
9. Only after acceptance retire the old `dev.hena.ren-ai`, old log agent, viewer-only asset LaunchAgent/listeners 4700/4701/47987 and the old Tailscale8447 mapping. Do not delete snapshots or unrelated Keychain items. Old source is rollback evidence, not a second active intake. Rollback after any new physical send requires reviewing both sides' send records before resuming the old app.

## Independent future relocation

**Mac:** follow [Relocate to another Mac](../../imsg.hena.dev/ops/README.md#relocate-to-another-mac). Docker services and OpenCode credentials stay untouched.

**Docker:** at an approved pause stop all consumers of the **five** exported volumes, including both OpenCode upstream and cookie proxy. `OC_DEPLOYMENT_DIRECTORY=… REN_AI_TUNNEL_TOKEN=… bash ops/export-docker.sh NEW-PRIVATE-BACKUP` refuses running mounts and captures **whole home** (all locations/sessions/provider credentials/projects), proxy data (browser cookie signing identity), read-only persona location (plugins/config/token/dependencies/templates), application state, and writable session folders (agents/instructions/persona snapshots/session configs). It also copies the external Compose/source/env read-only, the sessions overlay, external catalog, application env and separate application tunnel token. Restore supplies the latter as protected `application-tunnel.token`; read it into the Compose environment without logging it. Set custom location/session volume variables consistently for both Compose and export/restore. These five-volume archives are the ADR-0012 format; older four-volume backups need attended migration, not a silent empty session volume. Fleet database/certificates/secrets are exported separately by its tooling; restore them as part of a complete Docker-host move. Full-home restore preserves native fork/revert metadata and all unrelated OpenCode locations; scoped session exports are not a full-host backup.

On the new host, `bash ops/restore-docker.sh VERIFIED-BACKUP NEW-CONFIG-DIRECTORY` verifies checksums and restores into **new, nonexistent** named volumes; it never merges databases or starts containers. Default volume names match the current OpenCode project. Include restored `opencode.sessions.compose.yml` after the external base Compose file and review both volume names; never start a restored stack without its writable sessions submount. Review catalog/env host paths, retain the verified Basic-compatible proxy, and verify the restored public HTTPS OpenCode endpoint before application/bootstrap start or import. Start the callback/application in bootstrap mode and verify plugin/catalog/session counts, native UI/cookie/Basic/SSE/terminal operation and public Mac integration before moving production traffic. Review image architecture/version and keep `https://oc.hena.dev` across hosts; use a protected staging HTTPS hostname when checking a replacement before switching the stable route. Do not invent a private HTTP/shared-filesystem or Tailscale dependency. Activate intake only once, reconcile uncertain sends and pause-period messages, then retire the old Docker host. Keep application/OC/Fleet backups and credentials together under access control.

## Verification scope

Repo tests prove the transfer and service contracts; operation tests exercise native snapshot exports, pagination, artifact graph rejection and proxy credential behavior. Validate scripts with `bash -n` and Compose with configured staging values. Image builds and private artifact/installer checks are safe before live deployment. Actual PPPC delivery, public hostname routing, old-version snapshot fidelity and native UI/model behavior require the attended staged checks above; they are not claimed complete by source tests.

After changing runtime plugins, build the plugin image and run the compiled-plugin regression harness with the separate plugin-directory artifact layout. Its default path exercises cold activation and folder RPCs inside the compiled CLI using isolated fake services; `--preprovisioned` is only a debugging fallback. The former `/artifact/plugin` layout is obsolete. Cross-instance schema failures can escape embedded-runtime tests: keep every folder RPC input/output/error/event schema and the positive-number `wait` input behind opaque Standard Schema boundaries. Void folder operations return JSON `null` on the wire. `COMPILED_OPENCODE_IMAGE` can select the pinned CLI image when the local compatibility image is unavailable.
