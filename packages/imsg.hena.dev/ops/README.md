# Messages Mac service

`imsg.hena.dev` is the Mac-native messaging service from [ADR-0010](../../../docs/adr/0010-separate-the-messages-mac-from-opencode.md): imsg, Messages UI automation for typing/read/reaction behavior, history and delivery-status queries, and attachment conversion, behind an authenticated RPC API. It has no persona, application or OpenCode responsibilities. The Docker application calls it through `@ren-ai/imsg.hena.dev/client`; the [application runbook](../../api-msg.hena.dev/ops/README.md) covers the Docker services and the initial cutover. Permission provisioning through Fleet is in [MDM tooling](mdm/README.md).

No script below starts a service, stops an existing one, or changes an existing Cloudflare ingress. Install/restore refuse existing destinations. Run scripts with `bash` from `packages/imsg.hena.dev`. Treat exported archives as private: they contain service credentials. Encrypt and copy backups off-host yourself.

## Build and install

```sh
bash ops/build-mac.sh /absolute/new/artifact /absolute/reviewed/imsg
bash /absolute/new/artifact/install.sh /absolute/new/artifact /absolute/private/imsg.env
```

Build on macOS with Bun 1.4.2 and the reviewed **native imsg0.15.9** executable, not Homebrew's shell wrapper. On the inspected host this is `/opt/homebrew/Cellar/imsg/0.15.9/libexec/imsg`; use your actual reviewed native path on other hosts. The builder takes an optional third resource-directory argument, otherwise uses the native executable's directory; it requires/copies `imsg-bridge-helper.dylib`, `PhoneNumberKit_PhoneNumberKit.bundle`, and `SQLite.swift_SQLite.bundle` beside `bin/imsg`. It rejects wrappers, wrong versions/architectures and non-system dylib dependencies. The artifact also includes Bun, gateway/probe bundles, adjacent `messages-ui.applescript`, dependency graphs and SHA-256 checksums of every payload file. It has no Homebrew/OpenCode package installation or checkout dependency. Builder and installer verify architecture/checksums; the bundle graph rejects OpenCode and unbundled output dependencies. Copying an executable preserves its signing identity; do not re-sign it casually after creating Fleet profiles.

Default stable permission identities are `/usr/local/lib/ren-ai-messaging/bin/bun` and `…/bin/imsg`, matching the Fleet tooling's `MESSAGING_HOME` contract. Use `MESSAGING_HOME` for a different **absolute** path and give the same actual paths to the MDM profile generator (`IMSG_INSTALL_ROOT` remains an installer alias). Run as the GUI user, not root; installation requests attended sudo only to create/chown its new identity directory if needed. Default GUI LaunchAgent is `~/Library/LaunchAgents/dev.hena.ren-ai-imsg.plist`; `IMSG_LAUNCH_AGENT` can change the file path. Its label remains `dev.hena.ren-ai-imsg`. Installation never bootstraps it or stops the old AI app. Only IMSG_TOKEN/PORT/LISTEN_HOST are accepted in imsg.env. Bun's environment-file loader reads that protected file without putting the token in the plist.

Complete Apple Account sign-in, Messages history sync, [Fleet enrollment/PPPC delivery and launch-context checks](mdm/README.md), desktop login/awake policy, and Messages “Send read receipts.” At the approved step explicitly bootstrap the GUI LaunchAgent. Verify the **actual launchd process**, then run the bundled no-send probe using the same token:

```sh
ROOT="${MESSAGING_HOME:-/usr/local/lib/ren-ai-messaging}"
"$ROOT/bin/bun" --env-file="$ROOT/imsg.env" "$ROOT/verify.js"
```

The probe authenticates `/rpc`, reads Messages DB and ensures/parks the UI without selecting a user or sending. After local verification, test with `IMSG_URL=https://imsg.hena.dev/rpc` from the Docker side. Unauthorized requests must fail. Messages image conversion and attachment bytes are served by the Mac; Docker never accesses its filesystem.

Provision a **separate** Mac Cloudflare Tunnel and review its dashboard route `imsg.hena.dev` → `http://127.0.0.1:4702`. Put its raw token in an owner-only file (see `messaging-tunnel.token.example`), then `bash ops/install-mac-tunnel.sh /absolute/reviewed/cloudflared /absolute/private/raw-token` installs a separate GUI LaunchAgent **without loading it**. It uses `--token-file`, never a secret command-line argument/plist value, and disables automatic binary updates. It refuses existing tunnel/plist destinations. Explicitly bootstrap `dev.hena.ren-ai-imsg-tunnel.plist` only after local verification and ingress approval. The gateway never reads that credential. The artifact includes these installer/export/restore scripts; no app checkout is needed on the replacement Mac. No script mutates the existing tunnel or starts another AI intake. Rotate Mac stdout/stderr with `bash ops/rotate-logs.sh` from your chosen daily management schedule; it keeps fourteen days.

## Relocate to another Mac

Boot out only the messaging gateway and its separate messaging-tunnel LaunchAgents at the approved pause; `bash ops/export-mac.sh NEW-PRIVATE-BACKUP` exports both binaries, artifact, independent messaging/tunnel tokens and logs. It requires the installed tunnel so credentials cannot be accidentally omitted. On a same-architecture replacement, `bash ops/restore-mac.sh BACKUP NEW-STAGING` verifies the archive and generates both new configured-path plists **without starting**. Different architecture requires rebuilding artifact/Bun/imsg/cloudflared, then restoring only messaging/tunnel configuration/logs. Sign into the same Apple Account, synchronize history, enroll in Fleet, deliver profiles for the new actual identity paths and verify the launchd/public probe. Switch only `imsg.hena.dev` after verification. Docker services/OC credentials stay untouched; application reconciliation handles changed local Messages ROWIDs using durable GUID/date history. Confirm pause-period messages catch up.
