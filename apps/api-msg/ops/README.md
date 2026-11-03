# api-msg Docker executor

`https://api-msg.renai.im` serves the DB-free executor in Docker on the Messages
Mac. The stateful application is the Cloudflare Worker at `https://api.renai.im`.
The executor forwards authenticated requests to the existing `https://oc.renai.im`
and `https://imsg.renai.im/rpc` upstreams, plus the native social executor on the same Mac. It has no application database or
Turnstile credentials.

The executor also watches imsg's existing stream and recent-message edits, coalesces wake hints to `APPLICATION_API_URL`, and retries failed delivery. Cloudflare owns the bookmark, edit baselines, admission and all business decisions. Idle observation does not poll the Worker. See [ADR-0019](../../../docs/adr/0019-the-mac-observes-and-waits-cloudflare-decides-and-stores.md) and the [coordinated plugin/Worker release](../../api/ops/README.md#event-driven-execution-release-adr-0019).

## One-time provisioning

Docker must be running for the logged-in Mac user. Install native Bun **1.4.4** and Google Chrome Canary first. The default installation is
`$HOME/Library/Application Support/ren-ai-api-msg`; set `API_MSG_HOME` to use
another new absolute directory.

1. Configure a Cloudflare Tunnel public hostname:
   `api-msg.renai.im` → `http://api-msg:4700`. The tunnel runs alongside the
   executor on its private Compose network; port 4700 is not published to the host.
2. Copy [`api-msg.env.example`](api-msg.env.example) to an owner-only private file.
   Use the Worker's `TOKEN_MANAGEMENT` and the existing OpenCode Basic header and
   imsg token. Set `APPLICATION_API_URL=https://api.renai.im` and the Worker's `API_MSG_URL=https://api-msg.renai.im`.
3. Install the latest attested `main` bundle:

   ```sh
   cd apps/api-msg
   bash ops/install-from-ci.sh /absolute/private/api-msg.env
   bash ops/install-tunnel.sh /absolute/private/api-msg-tunnel-token
   ```

   The installer checks GitHub provenance and checksums and builds the pinned
   Bun Docker image. It also installs agent-browser **0.41.0** as a native binary,
   copies native Bun, and writes `im.renai.social` as a GUI LaunchAgent. Both
   executors use the same protected environment; browser profiles, the encrypted
   vault and logs stay in the host's private `social-state` and `social-logs`
   directories. Neither installer starts a service. Private environment and
   tunnel files are excluded from the image build context.

4. Start and verify:

   ```sh
    ROOT="${API_MSG_HOME:-$HOME/Library/Application Support/ren-ai-api-msg}"
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/im.renai.social.plist"
   docker compose -f "$ROOT/compose.yml" --profile ingress up -d --wait
   docker compose -f "$ROOT/compose.yml" exec -T api-msg bun /app/api-msg-verify.js
   ```

   The authenticated `/health` probe verifies the response shape without printing
   it. Disk usage describes the executor's filesystem. `screenLocked` is `null`
   in Docker: Linux cannot inspect the Mac GUI, so the Worker neither raises nor
   clears a screen-lock alert from that missing observation. Local native macOS
   development can still observe it. The `social` dependency must be ready and
   match the gateway's exact source revision. `/social/health` relays the native
   executor's authenticated dependency health through this same gateway.
   Docker reaches the loopback-bound native listener through
   `host.docker.internal:5407`; verify this connection with the installed Docker
   runtime before rollout. No separate social tunnel or Worker URL is needed.
   Health does not prove messaging upstream access;
   also verify OpenCode's authenticated `/opencode/api/info` and imsg's
   non-sending `probe` RPC through `/imsg/rpc`. Unauthorized requests must return 401.

The executor runs without writable application volumes, as the image's `bun`
user, with a read-only filesystem and bounded Docker logs. Docker restarts it
and its tunnel after engine restarts.

## Automatic updates

`GET /health` requires no authentication and reports `service: "api-msg"`, the
full source `revision` embedded by CI, and `status`. A locked screen, nearly-full
disk, failed Mac health check, or unavailable/unready/mismatched native social executor returns `degraded` with HTTP 503; ready returns 200. Local source runs use revision `development`. Responses are never cached.
The bundled probe requires this identity, its own artifact revision and readiness.
All other paths retain Bearer authentication with `TOKEN_MANAGEMENT`.

The existing messaging updater delivers the Mac deployment agent automatically
inside its attested `imsg.js` payload. No new Mac login or terminal command is
required for an installation that already has the messaging updater, Docker and
the protected `api-msg.env`. The new `im.renai.mac-deployment` GUI LaunchAgent runs
once a minute and reads the desired source revision from the authenticated Worker.
It disables future runs of `im.renai.api-msg-deploy` and waits for an already-running
legacy installer to finish before changing runtime files. The messaging updater
continues delivering messaging and deployment-agent updates.

Admin's **소셜 → Mac 실행기 자동 설치·복구** queues a persistent repair operation
in the existing social Durable Object. Refresh the page to see the operation's
stage, exact requested/installed revisions, and safe failure code/job ID. An
expired lease can be reclaimed after a process restart; stale reports cannot
overwrite a replacement operation. Requests for the same pending revision
coalesce. Failed automatic attempts have persisted backoff and a three-attempt
budget; an explicit new Admin request resets that budget. Artifact publication or
a busy legacy updater can defer a pending operation up to six attempts.

Before extraction or execution, the agent verifies `api-msg-bundle` provenance
against the exact main commit and verifies its checksums. The v2 artifact includes
the Docker build files and verifier as well as both JavaScript executors. The
agent installs agent-browser 0.41.0 without package scripts and reuses Canary;
if missing, it installs Google's signature-verified Canary in the user's
Applications directory. A managed Compose overlay updates only `api-msg`, keeping
the existing ingress service, Compose file, environment and tunnel credentials.

An existing native service's `SOCIAL_HOME`, Canary, port, model and OpenCode
directory are retained. Unknown existing profile locations fail closed. Profiles,
cookies and the encrypted credential vault are never copied into an image,
deleted or reset. Before replacing code or a native plist, the agent persists a
rollback journal. A failed installation restores the prior runtime and plist;
an interrupted installation is reconciled on the next attempt. The final ready
report requires both local readiness and public gateway health at the exact
artifact revision, including its same-revision native social dependency.

Agent configuration, retry state, rollback journal and private logs live in
`~/Library/Application Support/ren-ai-mac-deployment`. Logs contain bounded stage,
operation ID, duration and error/exit codes, excluding credentials, profiles and
command output. Successful runtime installation does not prove an account is
logged in: use that existing connection's **로그인 상태 확인** in Admin afterward.

For a reviewed local rollout before a CI artifact exists, build with
`bash ops/build-bundle.sh NEW-DIRECTORY`, then run
`bash ops/install.sh NEW-DIRECTORY /absolute/private/api-msg.env`. Run the quality
gates first; this local build is not a GitHub-attested artifact.

## API hostname cutover

Provision and verify the executor at `api-msg.renai.im` first. Stop the retired
stateful Docker application before enabling Worker intake, and preserve/export
its state using the [application runbook](../../api/ops/README.md). Release the
old tunnel route/DNS record at `api.renai.im`, then deploy the existing Worker
under that custom domain. Keep the same Worker identity and Durable Object
namespace. Update API callers and plugin callbacks, verify them, and remove the
retired `api-app.renai.im` domain without a redirect.

## Local development

Root `bun dev` starts api-msg at `http://127.0.0.1:4700` and api-app at
`http://127.0.0.1:4879`. Copy `apps/api-msg/.env.example` to `.env` and override
`API_MSG_PORT` when needed. Local upstreams default to OpenCode on 4096 and imsg
on 4702; these services must already be running. Production uses the public HTTPS
upstreams in the Docker environment example.
