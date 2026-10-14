# Messages Mac service

`imsg.renai.im` is the Mac-native messaging service from [ADR-0010](../../../docs/adr/0010-separate-the-messages-mac-from-opencode.md): imsg, Messages UI automation for typing/read/reaction behavior, history and delivery-status queries, and attachment conversion, behind an authenticated RPC API. It has no persona, application or OpenCode responsibilities. The Docker application calls it through `@ren-ai/imsg/client`; the [application runbook](../../api/ops/README.md) covers the Docker services and the initial cutover. Permission provisioning through Fleet is in [MDM tooling](mdm/README.md).

Apart from the deploy agent restarting the gateway it updates, no script below starts or stops a service or changes an existing Cloudflare ingress. Install/restore refuse existing destinations. Run scripts with `bash` from `apps/imsg`. Treat exported archives as private: they contain service credentials. Encrypt and copy backups off-host yourself.

## Build and install

```sh
bash ops/build-mac.sh /absolute/new/artifact /absolute/reviewed/imsg
bash /absolute/new/artifact/install.sh /absolute/new/artifact /absolute/private/imsg.env
```

Build on macOS with Bun 1.4.2 and the reviewed **native imsg0.15.9** executable, not Homebrew's shell wrapper. On the inspected host this is `/opt/homebrew/Cellar/imsg/0.15.9/libexec/imsg`; use your actual reviewed native path on other hosts. The builder takes an optional third resource-directory argument, otherwise uses the native executable's directory; it requires/copies `imsg-bridge-helper.dylib`, `PhoneNumberKit_PhoneNumberKit.bundle`, and `SQLite.swift_SQLite.bundle` beside `bin/imsg`. It rejects wrappers, wrong versions/architectures and non-system dylib dependencies. The artifact also includes Bun, gateway/probe bundles, adjacent `messages-ui.applescript`, dependency graphs and SHA-256 checksums of every payload file. It has no Homebrew/OpenCode package installation or checkout dependency. Builder and installer verify architecture/checksums; the bundle graph rejects OpenCode and unbundled output dependencies. Copying an executable preserves its signing identity; do not re-sign it casually after creating Fleet profiles.

Default stable permission identities are `/usr/local/lib/ren-ai-messaging/bin/bun` and `…/bin/imsg`, matching the Fleet tooling's `MESSAGING_HOME` contract. Use `MESSAGING_HOME` for a different **absolute** path and give the same actual paths to the MDM profile generator (`IMSG_INSTALL_ROOT` remains an installer alias). Run as the GUI user, not root; installation requests attended sudo only to create/chown its new identity directory if needed. Default GUI LaunchAgent is `~/Library/LaunchAgents/im.renai.imsg.plist`; `IMSG_LAUNCH_AGENT` can change the file path. Its label remains `im.renai.imsg`. Installation never bootstraps it or stops the old AI app. Only IMSG_TOKEN/PORT/LISTEN_HOST are accepted in imsg.env. Bun's environment-file loader reads that protected file without putting the token in the plist.

Complete Apple Account sign-in, Messages history sync, [Fleet enrollment/PPPC delivery and launch-context checks](mdm/README.md), desktop login/awake policy, and Messages “Send read receipts.” At the approved step explicitly bootstrap the GUI LaunchAgent. Verify the **actual launchd process**, then run the bundled no-send probe using the same token:

```sh
ROOT="${MESSAGING_HOME:-/usr/local/lib/ren-ai-messaging}"
"$ROOT/bin/bun" --env-file="$ROOT/imsg.env" "$ROOT/verify.js"
```

The probe authenticates `/rpc`, reads Messages DB and ensures/parks the UI without selecting a user or sending. After local verification, test with `IMSG_URL=https://imsg.renai.im/rpc` from the Docker side. Unauthorized requests must fail. Messages image conversion and attachment bytes are served by the Mac; Docker never accesses its filesystem.

Provision a **separate** Mac Cloudflare Tunnel and review its dashboard route `imsg.renai.im` → `http://127.0.0.1:4702`. Put its raw token in an owner-only file (see `messaging-tunnel.token.example`), then `bash ops/install-mac-tunnel.sh /absolute/reviewed/cloudflared /absolute/private/raw-token` installs a separate GUI LaunchAgent **without loading it**. It uses `--token-file`, never a secret command-line argument/plist value, and disables automatic binary updates. It refuses existing tunnel/plist destinations. Explicitly bootstrap `im.renai.imsg-tunnel.plist` only after local verification and ingress approval. The gateway never reads that credential. The artifact includes these installer/export/restore scripts; no app checkout is needed on the replacement Mac. No script mutates the existing tunnel or starts another AI intake. Rotate Mac stdout/stderr with `bash ops/rotate-logs.sh` from your chosen daily management schedule; it keeps fourteen days.

## Automatic deployment

Every push to `main` that passes the gates builds the gateway's JavaScript payload (`imsg.js`, `verify.js`, `messages-ui.applescript` and the two dependency graphs) with Bun 1.4.2 on a GitHub-hosted runner, attests its build provenance and uploads it as the `imsg-bundle` artifact ([`ci.yml`](../../../.github/workflows/ci.yml), [`build-bundle.sh`](build-bundle.sh)). CI never reaches the Mac. The Mac pulls instead: the `im.renai.imsg-deploy` LaunchAgent runs [`update.sh`](update.sh) every two minutes.

1. It considers only the newest push run of `ci.yml` on `main` and waits until that run completes. A run whose gates failed has no bundle and is skipped; a re-run that passes still deploys.
2. `gh attestation verify` must confirm that this repository's `ci.yml` built the bundle from `refs/heads/main` at that exact commit on a GitHub-hosted runner. An artifact from a fork, another workflow or a self-hosted runner stops here.
3. If `imsg.js`, `verify.js` and `messages-ui.applescript` match the installed ones, only metadata changed: it installs the bundle without probing or restarting the gateway.
4. Otherwise it probes the running gateway first, keeps the current payload in `deploy/previous`, swaps in the new one, refreshes `SHA256SUMS` so exports still restore, restarts the gateway with `launchctl kickstart -k` and runs the no-send probe.
5. If the probe fails, it restores the previous payload and restarts again. When the running gateway passed the first probe and passes again after the rollback, the bundle is at fault: the commit goes to `deploy/rejected` and is never retried.
6. When the running gateway already failed the first probe, or fails it after the rollback, the Mac is at fault: for example, Messages cannot come to the front. The agent still tries each new commit once, in case it is the fix, then records it in `deploy/deferred` and waits without restarting anything until the running gateway passes the probe.

The restart is forced on purpose. On SIGTERM the gateway stops accepting requests and waits up to 20 seconds for the application's open message stream to drain. During that time every send, typing indicator and read receipt fails, while a forced restart answers again within a second. A typing draft cut off by a restart is cleared before the next typing.

Only the payload changes. Bun, imsg, `imsg.env`, the tunnel and Fleet's permission profile stay untouched, so upgrading the binaries remains the attended build and install above. Because the Mac now deploys on its own schedule, keep changes to `@ren-ai/imsg/protocol` compatible with the running application.

Install the agent once, after the gateway probe passes:

1. Create a fine-grained GitHub token for the `hena-agent` organization, limited to `hena-agent/ren-ai`, with read-only **Actions** and **Attestations** permissions and nothing else. [This link](https://github.com/settings/personal-access-tokens/new?name=imsg.renai.im+deploy+agent&description=Messages+Mac+deploy+agent%3A+downloads+and+verifies+imsg+bundles+from+CI&target_name=hena-agent&expires_in=366&actions=read&attestations=read) pre-fills everything except the repository. The organization approves tokens from its owners automatically; others wait for an owner's approval. Copy the token and save it with `umask 077; pbpaste > ~/imsg-deploy-token`, so it never appears on screen or in shell history.
2. From `apps/imsg`, run `MESSAGING_HOME=… bash ops/install-deploy-agent.sh /opt/homebrew/bin/gh /absolute/private/raw-token`. It verifies the native `gh` and the token format, copies them and `update.sh` into `deploy/`, and writes `~/Library/LaunchAgents/im.renai.imsg-deploy.plist` **without loading it** (`IMSG_DEPLOY_LAUNCH_AGENT` changes the path).
3. `launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/im.renai.imsg-deploy.plist`. Its first run deploys the head of `main` once CI has attested a bundle for it.

The deployed commit is in `deploy/deployed`, a commit waiting for the Mac to recover in `deploy/deferred`, and the agent's output in `deploy/logs`. When the token expires, deployments stop with authentication errors in `deploy/logs/stderr.log` while the gateway keeps running: issue a new one the same way and overwrite `deploy/token` (owner-only); the next run uses it. Pause deployments with `launchctl bootout "gui/$(id -u)/im.renai.imsg-deploy"`. The agent never replaces its own `update.sh`: after reviewing a change to it, copy `ops/update.sh` over `deploy/update.sh`.

## Relocate to another Mac

Boot out the deploy agent first, then the messaging gateway and its separate messaging-tunnel LaunchAgents at the approved pause; `bash ops/export-mac.sh NEW-PRIVATE-BACKUP` exports both binaries, artifact, independent messaging/tunnel tokens and logs. It requires the installed tunnel so credentials cannot be accidentally omitted. On a same-architecture replacement, `bash ops/restore-mac.sh BACKUP NEW-STAGING` verifies the archive and generates the new configured-path plists, including the deploy agent's when it was installed, **without starting**. Different architecture requires rebuilding artifact/Bun/imsg/cloudflared, then restoring only messaging/tunnel configuration/logs. Sign into the same Apple Account, synchronize history, enroll in Fleet, deliver profiles for the new actual identity paths and verify the launchd/public probe. Switch only `imsg.renai.im` after verification, and bootstrap the deploy agent last. Docker services/OC credentials stay untouched; application reconciliation handles changed local Messages ROWIDs using durable GUID/date history. Confirm pause-period messages catch up.

## Move to imsg.renai.im

[ADR-0016](../../../docs/adr/0016-the-service-lives-at-renai-im-in-one-cloudflare-account.md) moves this service from `imsg.hena.dev` to `imsg.renai.im` and its LaunchAgents and permission profile from `dev.hena.*` to `im.renai.*`. Do it at the planned pause of the [application move](../../api/ops/README.md#move-to-renaiim), once the `imsg.renai.im` tunnel exists in the Ambivalent Co. account and CI has published a bundle from the new labels.

1. Stop the agents and give each plist its new label and file name:

   ```sh
   cd ~/Library/LaunchAgents
   for name in imsg-deploy imsg-tunnel imsg; do
     launchctl bootout "gui/$(id -u)/dev.hena.ren-ai-$name" || true
     plutil -replace Label -string "im.renai.$name" "dev.hena.ren-ai-$name.plist"
     mv "dev.hena.ren-ai-$name.plist" "im.renai.$name.plist"
   done
   ```

2. Delete the old `dev.hena.messaging.pppc.*` profile in Fleet, then from `apps/imsg` deliver the renamed one with `bun --env-file ops/mdm/.env run ops/mdm/profile-entry.ts --apply` ([MDM tooling](mdm/README.md)) and wait until Fleet shows it verified on the Mac. Fleet refuses a second profile with the same display name, and the renamed profile keeps the old one's, so the Mac has neither Full Disk Access nor Accessibility nor Automation in between. That is why the agents stop first.
3. Overwrite `$MESSAGING_HOME/tunnel/token` (owner-only) with the `imsg.renai.im` tunnel's raw token, and copy the reviewed `ops/update.sh` over `$MESSAGING_HOME/deploy/update.sh`: the installed copy restarts the gateway by its old label.
4. Bootstrap `im.renai.imsg.plist` and `im.renai.imsg-tunnel.plist`, run the no-send probe locally and through `https://imsg.renai.im/rpc`, then bootstrap `im.renai.imsg-deploy.plist` last.
