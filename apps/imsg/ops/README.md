# Rustpush messaging service

`imsg.renai.im` provides the authenticated `@ren-ai/imsg` RPC API. Its Bun gateway
supervises one native Rustpush bridge and owns SQLite message history. All Personas
use **hi@renai.im**, including first contact, replies and gestures. See
[ADR-0018](../../../docs/adr/0018-rustpush-owns-the-imessage-transport.md).
Service Notifications use **noti@renai.im** on the same Apple Account, through a
separate RPC and outgoing ledger. See [the alias runbook](notifications.md).

## Build and install

Build on Apple Silicon macOS with Bun 1.4.2, Rustup, Xcode command-line tools and
`protoc`. The pinned Rust toolchain and dependency revisions live in `apps/rustpush`.

```sh
bash apps/rustpush/prepare.sh
(cd apps/rustpush && cargo build --release --locked)
bash apps/imsg/ops/build-mac.sh /absolute/new/artifact "$PWD/apps/rustpush/target/release/ren-rustpush"
bash /absolute/new/artifact/install.sh /absolute/new/artifact /absolute/private/imsg.env
```

The artifact contains Bun, `ren-rustpush`, gateway/verifier JavaScript, dependency
graphs, operational scripts and checksums. The builder verifies architecture and
rejects non-system dylib dependencies; the installer checks checksums. There is no
runtime checkout dependency. `install.sh` requires new absolute install/plist paths
and does not start services. Run it as the intended LaunchAgent user. Set
`MESSAGING_HOME` to override `/usr/local/lib/ren-ai-messaging`.

Only `IMSG_TOKEN`, `IMSG_PORT` and `IMSG_LISTEN_HOST` are accepted in the protected
`imsg.env`; defaults are loopback port **4702**. The LaunchAgent runs in its installed
home. For local runs, `IMSG_HOME` selects a home containing `ren-rustpush`,
`history.sqlite`, `notifications.sqlite` and the `rustpush/` state directory.

Sign in locally before starting the gateway:

```sh
ROOT="${MESSAGING_HOME:-/usr/local/lib/ren-ai-messaging}"
RUSTPUSH_STATE_DIR="$ROOT/rustpush" "$ROOT/ren-rustpush" login
```

Passwords and verification codes are entered in the terminal. The service handle
must be registered to that account; startup fails closed otherwise. Contact Key
Verification was incompatible with the tested registration path. Account-setting
changes remain an operator decision. The transport uses native IDS/APNs and needs
neither Messages UI automation nor its Full Disk Access/Accessibility/Apple Events
permissions.

At the approved cutover, bootstrap `~/Library/LaunchAgents/im.renai.imsg.plist` and
verify the actual launchd process:

```sh
"$ROOT/bin/bun" --env-file="$ROOT/imsg.env" "$ROOT/verify.js"
```

Authenticated `GET /health` reports `imsg`, the exact artifact revision, and a
bounded history/session readiness probe. Ready is HTTP 200; degraded is HTTP 503.
The verifier requires the running revision to match its artifact. Then verify
through `IMSG_URL=https://imsg.renai.im/rpc`. The probe sends no message.
Health includes `dependencies.messages` and `dependencies.notifications`. During
the Mac-only rollout, Notification readiness is reported separately and does not
fail the updater's overall readiness probe. Discovery must not use it until the
alias runbook's local, public and live checks pass.

The separate Cloudflare Tunnel still routes `imsg.renai.im` to
`http://127.0.0.1:4702`. `install-mac-tunnel.sh` takes a reviewed cloudflared binary
and an owner-only token file and writes its LaunchAgent without loading it.
The gateway never reads the tunnel credential. `rotate-logs.sh` retains fourteen
days of logs.

## Durability and recovery

- `history.sqlite` is the gateway's durable cursor/status authority. Outgoing
  texts are recorded before submission. A timeout or lost process leaves the row
  pending; it is never automatically resent. A later delivery receipt can settle it.
- `submitText` accepts an application-owned attempt UUID and deduplicates it across
  restarts. `resolveSend` fences an absent UUID before reporting failure; late
  submissions cannot escape that fence. Preserve `send_fence` with `history.sqlite`
  during backups/restores. Fences never appear in message history. An admitted
  pending UUID remains uncertain. Deploy this gateway before the API that uses
  these RPCs; older clients can still use `sendText` during the rollout.
- `notifications.sqlite` stores only gateway-submitted Notifications and their
  delivery/read outcomes. It is never part of `after`, `recent` or `follow`, and
  cannot affect Persona statuses or gestures. Keep it with the rest of the home
  for backup and restore. Notification replies are discarded before saving their
  attachments; APNs spool data is removed after certification.
- `rustpush/` holds Apple registration/keys, the raw APNs notification spool and
  downloaded attachments. Notifications are persisted before APNs acknowledgement.
  They leave the spool after the gateway confirms storage and delivery certification
  succeeds. Duplicate GUIDs do not create duplicate history rows.
- A process lock prevents concurrent bridges using the same Apple state. The
  supervisor restarts failed/unresponsive processes with bounded backoff. Repeated
  failures raise alerts. Reauthentication is attended: stop the gateway before login.
- Keep the whole home private. Export includes Apple credentials, messages and
  attachment bytes. Encrypt backups and copy them off-host.

## Identified photo sends

`submitPhoto({ handle, base64, attemptID })` accepts one base64 JPEG (at most
10,000,000 decoded bytes). The authenticated gateway stages bytes privately and
uses the same durable attempt ledger and `resolveSend` fencing as identified text
sends. A photo is a separate attachment-only iMessage from `hi@renai.im`; there is
no text or SMS fallback. Deploy the combined native/gateway artifact before an
application starts calling this RPC. Older Macs reject it explicitly.

The ledger binds each attempt to its recipient and exact photo bytes. Duplicate
submissions do not upload or send again, including after a restart. Missing
attempts resolved first remain fenced. Preparation/upload rejection is failed;
an interrupted Apple submission stays unknown until a receipt reconciles it.
Private `outgoing-photos/` files remain with Mac message history and are included
in whole-home backups. History returns opaque attachment references, not local
paths. The application's Outbox owns photo admission and uncertainty; personas take
and inspect a Conversation photo before choosing to send it.

## Automatic deployment

CI checks native code on a GitHub-hosted Mac. Once all gates pass, it packages the
native bridge and gateway with Bun 1.4.2, attests provenance and publishes
`imsg-bundle`. The Mac's `im.renai.imsg-deploy` LaunchAgent pulls completed `main`
builds every two minutes; CI never reaches the Mac.

The updater verifies provenance, source revision, architecture and the Rustpush
payload. It replaces `imsg.js`, `verify.js`, `ren-rustpush`, graphs and artifact
metadata together. It retains the previous payload, refreshes checksums, restarts,
and requires an exact-revision ready probe. Failed updates roll back. A bad commit
is rejected when the old payload recovers; a host failing both probes defers updates
until recovery. Metadata-only updates avoid a restart. Bun, Apple state, SQLite
history, tokens and tunnel are preserved.

Install the deploy agent with `install-deploy-agent.sh REVIEWED_GH PRIVATE_TOKEN`.
Its fine-grained GitHub token needs only Actions/Attestations read access to
`hena-agent/ren-ai`. It writes the plist without loading it. Bootstrap the deploy
agent last, after local and public probes pass. State is in `deploy/deployed`,
`deploy/rejected` and `deploy/deferred`; logs are in `deploy/logs`. Pause it with
`launchctl bootout "gui/$(id -u)/im.renai.imsg-deploy"`.

## Attended production cutover

The operator authorized completing the transport cutover on 2026-10-17. It remains
pending until PR #104's gates pass and the paused-state checks below are complete.
The existing Mac updater expects the removed imsg/UI payload; pause it before
merging so it cannot attempt to install the new artifact using the old updater.

1. Put api-app in bootstrap-only mode and verify that the running Durable Object
   reports it. Drain/stop active OpenCode turns before stopping the gateway, so no
   text submission races the final snapshot. Pause both Mac deployment agents for
   the attended change. Keep the tunnel route and service credentials.
2. Export application state through `/management/state/export`. The route correctly
   refuses a live export with HTTP 409. Preserve Conversation/session IDs,
   `bookmark`, `intake_seen`, reset boundaries and the send ledger. Match every
   uncertain send against the old gateway by GUID; retain unmatched uncertainty
   without submitting it again.
3. Capture all old gateway rows and each outgoing row's status, then stop the old
   gateway. Back up its installation, launch/deploy plists and Messages database.
   Seed a new Rustpush `history.sqlite` offline, retaining each row's **original
   ID, GUID, handle, timestamp, text and details**, plus outgoing state/error/read
   timestamp. Copy historical attachments into the new private home and replace
   only their local paths. Do not retain a runtime dependency on Messages.app.
4. Verify SQLite integrity, exact row/status equality, unique GUIDs, attachment
   bytes, and `after(cursor, limit)` across every retained boundary. Verify new
   inserts receive IDs above the old maximum. Do not reset the application cursor
   or replay old prompts. A rehearsal on 2026-10-17 preserved 368 rows (maximum ID
   370), all 205 outgoing statuses and four original image files; the final paused
   snapshot must repeat these checks rather than reuse this live rehearsal.
5. Install the attested combined artifact and the new updater into a fresh home.
   Restore the tested Apple state while its bridge is stopped, preserving the
   original private backup. Start only the new gateway, let its persisted/APNs
   backlog catch up, and compare GUIDs against Messages received during the pause.
   GUID deduplication must retain imported rows while appending genuinely new ones.
6. Verify local and public health against the exact artifact revision. Exercise
   first contact, replies, read/typing/tapback, images, restart/replay and send-status
   reconciliation through api-msg and the existing application sessions. Resume
   api-app and verify each pause-period inbound is admitted once. Start the new
   deploy agent last, then retire the old executable and Messages automation.

Keep the old installation/data as an offline rollback archive. If a post-switch
send has an uncertain outcome, preserve the new history and reconcile it before
an attended rollback; never resend automatically or run two live intake paths.

## Relocation

Stop the deploy agent, gateway and separate tunnel at the approved pause, then run
`export-mac.sh NEW-PRIVATE-BACKUP`. It archives the complete home, including Apple
state, SQLite history/WAL, attachments and tunnel credentials. `restore-mac.sh
BACKUP NEW-STAGING` verifies the archive and creates new plists without starting.
Use the same architecture or rebuild the executable artifact first. Verify Apple
session restoration on the new hardware, then local/public probes and pause-period
catch-up before switching routing. Start the deploy agent last.
