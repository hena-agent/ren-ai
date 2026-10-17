# api-msg Docker executor

`https://api-msg.renai.im` serves the DB-free executor in Docker on the Messages
Mac. The stateful application is the Cloudflare Worker at `https://api.renai.im`.
The executor forwards authenticated requests to the existing `https://oc.renai.im`
and `https://imsg.renai.im/rpc` upstreams. It has no application database or
Turnstile credentials.

The executor also watches imsg's existing stream and recent-message edits, coalesces wake hints to `APPLICATION_API_URL`, and retries failed delivery. Cloudflare owns the bookmark, edit baselines, admission and all business decisions. Idle observation does not poll the Worker. See [ADR-0018](../../../docs/adr/0018-the-mac-observes-and-waits-cloudflare-decides-and-stores.md) and the [coordinated plugin/Worker release](../../api/ops/README.md#event-driven-execution-release-adr-0018).

## One-time provisioning

Docker must be running for the logged-in Mac user. The default installation is
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
   Bun Docker image. Neither installer starts a service. Private environment and
   tunnel files are excluded from the image build context.

4. Start and verify:

   ```sh
   ROOT="${API_MSG_HOME:-$HOME/Library/Application Support/ren-ai-api-msg}"
   docker compose -f "$ROOT/compose.yml" --profile ingress up -d --wait
   docker compose -f "$ROOT/compose.yml" exec -T api-msg bun /app/api-msg-verify.js
   ```

   The authenticated `/health` probe verifies the response shape without printing
   it. Disk usage describes the executor's filesystem. `screenLocked` is `null`
   in Docker: Linux cannot inspect the Mac GUI, so the Worker neither raises nor
   clears a screen-lock alert from that missing observation. Local native macOS
   development can still observe it. Health does not prove upstream access;
   also verify OpenCode's authenticated `/opencode/api/info` and imsg's
   non-sending `probe` RPC through `/imsg/rpc`. Unauthorized requests must return 401.

The executor runs without writable application volumes, as the image's `bun`
user, with a read-only filesystem and bounded Docker logs. Docker restarts it
and its tunnel after engine restarts.

## Automatic updates

`GET /health` requires no authentication and reports `service: "api-msg"`, the
full source `revision` embedded by CI, and `status`. A locked screen, nearly-full
disk or failed Mac health check returns `degraded` with HTTP 503; ready returns 200. Local source runs use revision `development`. Responses are never cached.
The bundled probe requires this identity, its own artifact revision and readiness.
All other paths retain Bearer authentication with `TOKEN_MANAGEMENT`.

The Mac pulls the attested `api-msg-bundle` published by CI after the quality
gates. Provision the deploy LaunchAgent using a fine-grained GitHub token for
`hena-agent/ren-ai` with read-only Actions and Attestations permissions:

```sh
cd apps/api-msg
bash ops/install-deploy-agent.sh /opt/homebrew/bin/gh /absolute/private/raw-github-token
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/im.renai.api-msg-deploy.plist"
```

This LaunchAgent is only the updater; the executor and tunnel run in Docker.
Every two minutes it checks `main` provenance, probes the current container,
installs changed JavaScript, rebuilds the image and replaces only the `api-msg`
Compose service. Metadata-only changes do not restart it. Failed builds or probes
restore the previous payload and container; rejected commits wait for a newer
artifact, while a previously unhealthy executor is retried after recovery.
The updater keeps its installed Compose/Dockerfile and private environment;
changes to those deployment files require an explicit operator update.

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
