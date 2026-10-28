---
status: accepted
---

# The Mac observes and waits; Cloudflare decides and stores

[ADR-0026](0026-idle-ren-ai-spends-no-cpu-on-the-free-plan.md) makes the Free plan a requirement: it removes the five-minute safety net and moves Mac health checks to a separate monitor, so the cost estimate below no longer applies. The rest of this decision stands.

This revises ADR-0014's two-second heartbeat, streaming `wait`, and startup-wide reconciliation. Keeping authoritative application state in Cloudflare is the priority; fitting the Free plan is not a requirement.

## Decision

- **The Mac sends wake hints.** The DB-free api-msg executor resumes the existing imsg `follow` stream from Cloudflare's bookmark. It coalesces bursts and retries failed wake delivery with capped backoff. It watches recent incoming text for edits locally. `GET /management/intake/watch` supplies the bookmark and unexpired edit baselines; authenticated `POST /management/intake/wake` durably schedules intake and returns 202 without waiting for OpenCode. Both reuse `TOKEN_MANAGEMENT`. A hint is not message admission or permission to send.
- **Cloudflare remains the only application writer.** It pulls Messages rows, preserves the durable intake queue, GUID/prompt deduplication, burst-reply fences, send uncertainty, assignments, follow-ups and failed-turn policy. Incoming text baselines survive eviction for the 15-minute edit window. Discovery's admission-rate history and the model context's seen-message identity also survive eviction. Edit and unsend notifications enter the existing durable admission queue.
- **One alarm follows persisted work.** First-contact reservations, follow-ups, pending intake, turn probes, interrupted rebuilds, relationship endings and edit expiry determine the next wake. Wake hints received during an alarm remain pending until processed. Failures back off rather than creating an immediate alarm loop. A five-minute maintenance and health safety net catches missed hints and performs a bounded rotating failed-turn scan. Mac-outage alerts therefore have roughly five-minute detection latency, plus request/dependency delays.
- **The OpenCode plugin waits locally.** Its timer and post-admission inbox subscription live on the Mac. A context acknowledges the actual message IDs it contains; an arrival outside that context interrupts the next/current wait. Waits remain capped at 55 minutes and are cancelled with the tool's scope. Plugin disposal cancels local waiting; Cloudflare's recovery policy handles interrupted turns. Terminal execution events send finite observation callbacks, with persisted probes and maintenance as recovery if delivery fails. Cloudflare no longer exposes the streaming wait RPC. Context acknowledgement, outgoing status and settled sends share one finite RPC.
- **Startup reconstructs handles, not all remote work.** The runtime Catalog and applied revision/rules fingerprint are durable. Fetch the Catalog on first initialization and committed-change notifications, never on the maintenance heartbeat. Startup skips synchronization for an applied revision/rules fingerprint. Maintenance reconciles newly created or moved native sessions against the cached Catalog; unchanged folders are not rewritten. Both paths preserve current Conversation State/Memory and retained snapshots. Completed session stops remain completed after eviction. Interrupted rebuilds are explicit bounded recovery work.
- **Admin polls only while useful.** Image progress polling pauses in hidden tabs and stops when work finishes, even with an open options dialog. Completed previews apply immediately. Closing that dialog applies the cached finished page, without another poll; a new submission supersedes the cached page.

## Cost and scaling

The old nominal two-second cadence was 43,200 alarms/day. A five-minute idle safety net is approximately 288/day; actual activity adds wakes and upstream requests. This is an architectural estimate, not a measured bill. Alarm/storage writes, SQL rows read, live requests, CPU and billed Durable Object duration still matter. Idle hibernation-eligible time must not be counted as automatically billable. No Free-plan or monthly-cost guarantee follows from this decision.

The application remains one Durable Object. Work-driven calls scale with activity, and failed-turn/rebuild recovery scans are bounded. Native-session Catalog reconciliation still inventories managed sessions every five minutes; it does not fetch Admin's Catalog. That inventory and global Messages-history queries for quote/tapback lookup remain separate scaling concerns.

## Release

This changes the Worker/plugin protocol. Use the planned-pause procedure in `apps/api/ops/README.md`: stage artifacts, pause execution, install a fresh plugin location, deploy the matching Worker, and resume one application only. api-msg updates from CI artifacts, but its protected environment and the installed OpenCode plugin volume are operator-managed. No source change proves that the Mac has installed the artifact or that public tunnel routing is ready.

Verify pause-period intake, duplicate hints, edits across actor replacement, pending recovery, reaction/context ordering, local wait interruption and exact service revisions before declaring rollout complete. Rollback requires matching Worker/plugins and reconciliation of physical-send records; never blindly resend uncertain work.
