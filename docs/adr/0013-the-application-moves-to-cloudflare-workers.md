---
status: proposed
---

# The application moves to Cloudflare Workers, with its state in one Durable Object

The application (`packages/api-msg.hena.dev`, served at `api-msg.hena.dev`) runs as a long-lived Bun process in Docker on the Messages Mac and is deployed by hand (ADR-0010). The owner wants it on Cloudflare Workers, deployed automatically on every push to `main`. Workers has no long-lived processes. A Durable Object restarts on every deploy, and each outbound connection keeps it alive for at most 15 minutes ([research](../specs/workers-replatform-research.md)). The move therefore changes how the application waits, not what it does. This revises ADR-0010's Docker application service and ADR-0006's SQLite file and nightly backups.

## Proposed decision

- **One Durable Object holds the application.** A SQLite-backed Durable Object owns every table the application has today (users, conversations, sends, the inbox bookmark, follow-ups, waitlist) through `@effect/sql-sqlite-do`, and is their only writer. A stateless Worker routes `/onboarding`, `/personas`, `/waitlist`, the plugin's `/rpc` and the operator API to it. One object matches today's single process and single file, and the per-object ceiling of about 1,000 requests/s is far above this service's load. Partitioning by conversation stays a later option.
- **Loops become one alarm-driven heartbeat.** Everything that now runs forever in the process moves onto the object's single alarm: polling the Mac for rows after the inbox bookmark through the existing `after` request, edit and unsend detection, follow-ups, health checks, and at a slower cadence failed-turn recovery (today's `recover`) and the catalog refresh. Nothing depends on a connection surviving a deploy, and the Mac needs no change. Incoming messages wait up to one beat.
- **`wait` stays a streaming request.** A request has no wall-clock limit while its caller stays connected, so the plugin's 55-minute `wait` with 20-second heartbeats keeps working. A deploy cuts it, so the plugin learns to re-issue an interrupted `wait` for the remaining time.
- **The Mac and OpenCode stay where they are.** The object calls `https://imsg.hena.dev` and `https://oc.hena.dev` as the Docker application does today, with `global_fetch_strictly_public` so same-zone requests pass through Cloudflare's front door like any other client. Workers VPC (beta) could later take both off the public Internet.
- **Operations.** The operator CLI calls an authenticated HTTPS endpoint instead of a Unix socket. Durable Object point-in-time recovery (30 days) replaces the nightly files on the Mac.
- **Deployment.** After the gates pass on `main`, CI runs `wrangler deploy` and a smoke check, the same way it deploys discovery.hena.dev. `wrangler rollback` is the way back. Durable Object classes use Wrangler's `exports` field. Every deploy restarts the object, so startup reconciles everything a restart can interrupt, the rule ADR-0010 already applies to reconnects.

## Open decisions

1. **Plan and cadence.** One always-resident object uses about 332,000 GB-s a month. That fits within Workers Paid's included 400,000 and uses most of the Free plan's daily allowance. Proposed: Workers Paid ($5/month) and a 2-second beat, tuned during the spikes.
2. **Push instead of polling.** The Mac could push rows instead. That gives lower latency, but it needs a new Mac-to-application credential and coordinated deploys of both sides, and the Mac now deploys itself. Proposed: poll until latency matters.
3. **The persona catalog.** `HEAD` already requires the Admin catalog Worker (`PERSONA_CATALOG_URL`, `PERSONA_CATALOG_TOKEN`), and the running application has neither setting. Proposed: deploy the catalog Worker with its real D1 database first, also from CI. Its Cloudflare token then needs `D1:Edit` for migrations.

## Migration in stages

Each stage leaves a working product.

0. **Catalog prerequisite.** Deploy the catalog Worker and configure the running Docker application for it, so the current `HEAD` can run at all.
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
   - Move `api-msg.hena.dev` from the tunnel to the Worker, resume, and verify with a marked test Handle.
   - Keep the stopped container and its volume for rollback.
5. **Automatic deployment.** Add the `wrangler deploy` job to CI, then retire the Docker application and its tunnel.

## Acceptance

- A push to `main` that passes the gates deploys the application without manual steps. A failed smoke check is visible, and rollback is one command.
- No inbound message, uncertain send, follow-up or failed turn is lost across a deploy or a Durable Object restart.
- The Mac and OpenCode run unchanged. The plugin changes only to retry an interrupted `wait`.
- The Mac no longer hosts the application.
