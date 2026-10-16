---
status: accepted
---

# The application moves to Cloudflare Workers, with its state in one Durable Object

The stateful application (`apps/api`, served at `api-app.renai.im`) runs as a long-lived Bun process in Docker on the Messages Mac and is deployed by hand (ADR-0010). It moves to Cloudflare Workers as `@ren-ai/api-app`, with its SQLite Durable Object as the sole owner of application state. The separate DB-free `@ren-ai/api-msg` executor remains on the Messages Mac at `api.renai.im`; it forwards to the existing OpenCode and imsg upstreams. Workers has no long-lived processes. A Durable Object restarts on every deploy, and each outbound connection keeps it alive for at most 15 minutes ([research](../specs/workers-replatform-research.md)). The move therefore changes how the application waits, not what it does. This revises ADR-0010's Docker application service and ADR-0006's SQLite file and nightly backups.

## Decision

- **One Durable Object holds the application.** A SQLite-backed Durable Object owns application state through `@effect/sql-sqlite-do`, and is its only writer. A stateless Worker routes Discovery registration, management, the plugin's `/rpc` and the operator API to it. One object matches today's single process and single file, and the per-object ceiling of about 1,000 requests/s is far above this service's load. Partitioning by conversation stays a later option.
- **Loops become one alarm-driven heartbeat.** Polling the Mac for rows after the inbox bookmark through the existing `after` request, edit and unsend detection, follow-ups, health checks and failed-turn recovery run on the object's single alarm. Catalog refresh is change-driven: after a committed save Admin calls the authenticated application management endpoint. Startup loads the catalog once; heartbeats never poll it. Nothing depends on a connection surviving a deploy, and the Mac needs no change. Incoming messages wait up to one beat.
- **`wait` stays a streaming request.** A request has no wall-clock limit while its caller stays connected, so the plugin's 55-minute `wait` with 20-second heartbeats keeps working. A deploy cuts it, so the plugin learns to re-issue an interrupted `wait` for the remaining time.
- **The Mac and OpenCode stay where they are.** The object calls `https://api.renai.im` using the existing `TOKEN_MANAGEMENT`; that DB-free gateway calls `https://imsg.renai.im` and `https://oc.renai.im` with their existing credentials. OpenCode plugins use the same `TOKEN_MANAGEMENT` environment variable for authenticated callbacks; no separate token file is required. The catalog remains in Admin D1.
- **Operations.** The operator CLI calls an authenticated HTTPS endpoint instead of a Unix socket. Durable Object point-in-time recovery (30 days) replaces the nightly files on the Mac.
- **Deployment.** After the gates pass on `main`, CI runs `wrangler deploy` and a smoke check, the same way it deploys discovery.hena.dev. `wrangler rollback` is the way back. Durable Object classes use Wrangler's `exports` field. Every deploy restarts the object, so startup reconciles everything a restart can interrupt, the rule ADR-0010 already applies to reconnects.

## Settled choices

1. **Workers Paid, with a 2-second beat.** One always-resident object uses about 332,000 GB-s a month: within Paid's included 400,000, but most of the Free plan's daily allowance. The beat is tuned during the spikes.
2. **Polling, not push.** Having the Mac push rows would cut latency, but it needs a new Mac-to-application credential and deploys of both sides in a compatible order, and the Mac now deploys itself. Polling stays until latency matters.
3. **The persona catalog stays in Admin D1.** The application reads the catalog through its existing authenticated interface; CI deploys the Workers in the same Cloudflare account using its existing token.
4. **Admin pushes catalog-change notifications.** Admin already has the application's management URL and credential. It calls `POST /management/catalog/refresh` after a committed catalog edit instead of making the application repeatedly check for edits. The receiver reloads the latest catalog and synchronizes active session folders while preserving live State/Memory and retained snapshots. Admin stores pending delivery in its existing Durable Object before committing, and retries failed or interrupted delivery with capped backoff using its shared alarm. Successful delivery clears the pending marker; duplicate notifications are safe. No heartbeat or new-conversation catalog polling is needed.

## Migration in stages

Each stage leaves a working product.

0. **Catalog prerequisite.** Deploy the catalog Worker from CI, publish the personas that new onboarding needs, and configure the running Docker application for the catalog, so the current `HEAD` can run at all.
1. **Spikes.** On a staging Worker with intake off, confirm:
   - `@effect/sql-sqlite-do` transactions inside an Effect `HttpRouter`; none of the eight `withTransaction` call sites may nest.
   - `@opencode/client/effect` against `oc.hena.dev` from workerd (so far only inspected).
   - Same-zone calls to the tunnel hostnames with `global_fetch_strictly_public`.
   - A 55-minute `wait` survives a deploy through the plugin's retry.
2. **Platform edges behind layers.** Make the SQL client, HTTP serving, scheduler, operator transport and backups replaceable layers. Replace the long-running loops with the heartbeat while the application still runs and ships from Docker.
3. **Worker build.** Add the Worker entry, the Durable Object and `wrangler.jsonc`. Run them on a staging hostname in bootstrap mode, with no intake and no scheduling, so there is never a second intake.
4. **Cutover during a planned pause.**
   - Stop Docker intake and scheduling, and settle or record uncertain sends.
   - Export `server.sqlite` and import it into the object.
   - Keep the old intake paused until the imported store is verified, then enable exactly one intake and verify with a marked test Handle.
   - Keep the stopped container and its volume for rollback; leave the Mac executor tunnel in place.
5. **Automatic deployment.** CI deploys `api-app.renai.im` after quality gates and smoke-checks `/health` and `/discovery/personas`. Deployment remains bootstrap-only until the controlled cutover enables intake.

## Acceptance

- A push to `main` that passes the gates deploys the application without manual steps. A failed smoke check is visible, and rollback is one command.
- No inbound message, uncertain send, follow-up or failed turn is lost across a deploy or a Durable Object restart.
- The Mac and OpenCode run unchanged. The plugin changes only to retry an interrupted `wait`.
- The Mac no longer hosts the application.
