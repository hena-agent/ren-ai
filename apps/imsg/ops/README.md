# Rustpush messaging service

`imsg.renai.im` provides the authenticated `@ren-ai/imsg` RPC API. Its Bun gateway
supervises one native Rustpush bridge and owns SQLite message history. All Personas
use **hi@renai.im**, including first contact, replies and gestures. See
[ADR-0018](../../../docs/adr/0018-rustpush-owns-the-imessage-transport.md).

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
`history.sqlite` and the `rustpush/` state directory.

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

The separate Cloudflare Tunnel still routes `imsg.renai.im` to
`http://127.0.0.1:4702`. `install-mac-tunnel.sh` takes a reviewed cloudflared binary
and an owner-only token file and writes its LaunchAgent without loading it.
The gateway never reads the tunnel credential. `rotate-logs.sh` retains fourteen
days of logs.

## Durability and recovery

- `history.sqlite` is the gateway's durable cursor/status authority. Outgoing
  texts are recorded before submission. A timeout or lost process leaves the row
  pending; it is never automatically resent. A later delivery receipt can settle it.
- `rustpush/` holds Apple registration/keys, the raw APNs notification spool and
  downloaded attachments. Notifications are persisted before APNs acknowledgement.
  They leave the spool after the gateway confirms storage and delivery certification
  succeeds. Duplicate GUIDs do not create duplicate history rows.
- A process lock prevents concurrent bridges using the same Apple state. The
  supervisor restarts failed/unresponsive processes with bounded backoff. Repeated
  failures raise alerts. Reauthentication is attended: stop the gateway before login.
- Keep the whole home private. Export includes Apple credentials, messages and
  attachment bytes. Encrypt backups and copy them off-host.

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

## Production cutover is pending

Implementation and local tests do not authorize production cutover. The existing
Mac updater expects the removed imsg/UI payload. At the separately approved pause,
stop that updater and intake before replacing the installation and updater.
Preserve application memory/state and reconcile every uncertain send first.

A fresh Rustpush history does **not** import Messages.app history. Historical
backfill and pause-period catch-up must be resolved and verified before switching
production. Keep the old installation/data available for the attended rollback;
do not run two live intake paths. Verify first contact, replies, read/typing/tapback,
images, restart/replay, status reconciliation and public readiness before resuming.

## Relocation

Stop the deploy agent, gateway and separate tunnel at the approved pause, then run
`export-mac.sh NEW-PRIVATE-BACKUP`. It archives the complete home, including Apple
state, SQLite history/WAL, attachments and tunnel credentials. `restore-mac.sh
BACKUP NEW-STAGING` verifies the archive and creates new plists without starting.
Use the same architecture or rebuild the executable artifact first. Verify Apple
session restoration on the new hardware, then local/public probes and pause-period
catch-up before switching routing. Start the deploy agent last.
