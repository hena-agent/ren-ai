# Fleet Free and Mac permission provisioning

This is the MDM part of [ADR-0010](../../../../docs/adr/0010-separate-the-messages-mac-from-opencode.md). Fleet, MySQL and Redis are self-hosted Docker services. The Mac runs only the native messaging gateway; it receives no OpenCode credentials. No Fleet Premium license, paid Apple developer membership, S3 service, Cloudflare Access subscription or Tailscale is used.

## Prerequisites

- Docker Compose, Bun, OpenSSL and `shasum`; run Mac inspection/enrollment on the target Mac (currently macOS 26.6.2).
- Public DNS and a free Cloudflare Tunnel for `fleet.hena.dev`. Apple devices must reach its MDM endpoints without an interactive login or Access challenge. Fleet's management API uses native Bearer authorization; its MDM protocol authenticates enrolled devices using certificates.
- An administrator for the Mac, an Apple Account for annual APNs renewal, and organization name/contact details for Fleet's free hosted CSR signing service. Fleet stores the generated MDM keys/certificates in MySQL; `FLEET_SERVER_PRIVATE_KEY` must survive relocation.
- A dedicated, logged-in/unlocked Mac desktop with the service Apple Account in Messages. Device Enrollment is attended and **must be user-approved Device Enrollment**, not BYOD User Enrollment. Apple Business/ADE is not required for this manual enrollment path.

Nothing here bypasses TCC, edits its database, changes SIP or grants permissions to Terminal.

## 1. Start Fleet locally

```sh
packages/api-msg.hena.dev/ops/mdm/setup.sh
```

This creates a local mode-0600 `.env` once, generates database/encryption secrets, starts the pinned images and waits for health checks. Re-running preserves keys. Volumes persist MySQL (including Fleet's APNs/MDM certificate material), Redis and Fleet filesystem data. MySQL/Redis publish no ports; Fleet publishes loopback port 8081 only. amd64 Fleet/MySQL match Fleet's official Compose deployment on Apple Silicon.

Before exposing a fresh instance publicly, create the initial Fleet administrator at `http://127.0.0.1:8081` (or your configured `FLEET_LOCAL_PORT`), so a stranger cannot claim the first-admin setup. Then route the existing Cloudflare Tunnel to that listener. For a **host-native** tunnel, add this route before its final catch-all, using your existing tunnel configuration/deployment process:

```yaml
ingress:
  - hostname: fleet.hena.dev
    service: http://127.0.0.1:8081
  # Retain existing routes and the existing final catch-all.
```

For a **Docker** tunnel, connect it to `ren-ai-fleet_default` and use `http://fleet:8080`, not its own container's localhost. Alternatively, the optional `ingress` Compose profile supplies a pinned tunnel container: put an already-created tunnel's token into ignored mode-0600 `ops/mdm/cloudflare-token`, configure its public hostname `fleet.hena.dev` to `http://fleet:8080` in Cloudflare, then run `docker compose --profile ingress up -d tunnel` from this directory. `CLOUDFLARE_TOKEN_FILE` can point to an external protected token file. Do not print tokens or put them on command lines. Keep/restore existing tunnel credentials and hostname routing separately; neither script changes live Cloudflare configuration.

Verify public HTTPS is working before generating enrollment profiles. During initial Fleet admin setup, set its server URL to `https://fleet.hena.dev`; retain this address on relocation so Macs need not re-enroll.

## 2. Complete the attended prerequisites

Run the repeatable [four-stage wizard](attended-setup.sh) **on the target Mac**:

```sh
packages/api-msg.hena.dev/ops/mdm/attended-setup.sh
```

It guides Fleet administrator sign-in/API-token retrieval (`My account > Get API token`, `/profile`), APNs CSR exchange, user-approved enrollment, then Messages sign-in/history checks. It saves only `FLEET_URL` and the hidden `FLEET_API_TOKEN` to the local mode-0600 setup `.env`. `FLEET_SETUP_ENV` selects another setup file. It downloads the enrollment profile through Fleet's native authenticated API and opens it for human approval; this is **not** manual PPPC installation. Do not run the wizard unattended.

In Fleet: Settings > Integrations > MDM > Turn on Apple MDM > Download CSR; at [Apple Push Certificates Portal](https://identity.apple.com/pushcert/), create a certificate, upload that CSR and download `.pem`; upload `.pem` into Fleet. Record the APNs account, certificate Common Name and renewal date in protected operator records. The CSR signer is a free external Fleet service, not a paid entitlement.

## 3. Install the gateway, then deliver PPPC automatically

Use the separate Mac gateway installer first. Its launchd `ProgramArguments[0]` must be the installed Bun, and imsg must be the installed executable, **not** executables in a checkout or Homebrew symlinks that change unexpectedly. Default layout:

```text
/usr/local/lib/ren-ai-messaging/bin/bun
/usr/local/lib/ren-ai-messaging/bin/imsg
```

Set `MESSAGING_HOME` in the setup `.env` if the installer uses a different stable location. Provisioning resolves actual filesystem paths, verifies signatures, reads `codesign -dr -` designated requirements, locates Messages/System Events using the target Mac's application lookup, and reads their **actual** bundle IDs and requirements. Ad-hoc signatures are supported, but their cdhash requirement changes on upgrade; regenerate/reapply policy after replacing either binary. Unsigned/invalid binaries or missing receiver identities fail closed.

From `packages/api-msg.hena.dev`:

```sh
# Inspection and local generation only; no Fleet mutation:
bun --env-file ops/mdm/.env run ops/mdm/profile-entry.ts
# Delivers the generated profile through Fleet's free authenticated API:
bun --env-file ops/mdm/.env run ops/mdm/profile-entry.ts --apply
```

The generated profile grants Full Disk Access, Accessibility and AppleEvents to the **installed Bun and imsg paths**, with AppleEvents restricted to the discovered Messages and System Events receivers. Bun is the responsible process for the launchd gateway and its UI automation; imsg is included for native subprocess attribution. Neither `osascript` nor Terminal receives a blanket grant. `PPPC_PROFILE_PATH` overrides the protected local output path.

Fleet Free applies this profile to all **Unassigned** Macs. Dedicate this Fleet instance to the messaging Macs; Free does not provide paid team/label targeting. The identifier, UUIDs and display name derive from policy content. Re-running identical provisioning uses POST, then on HTTP 409 paginates/downloads and validates identical existing bytes. A mismatch fails closed. Binary/receiver changes create a new distinctly named policy; no unrelated profile is replaced/deleted. We do **not** use Premium PATCH or destructive batch replacement. Once a new profile has been verified, an operator may remove obsolete **messaging-owned** versions in Fleet; never remove unrelated profiles.

## 4. Verify the actual launchd service before switching traffic

Wait until Fleet shows the profile installed on the enrolled Mac, not merely uploaded/pending. Start/restart the gateway through its launchd installer, using the same installed binaries inspected above. Keep the service user logged in and desktop unlocked.

The verification CLI calls the authenticated gateway, so permission-sensitive actions run in **Bun's launchd context**, not the provisioning shell:

```sh
# Use the gateway's mode-0600 env file containing IMSG_TOKEN, not the Fleet token.
# Run from packages/api-msg.hena.dev; replace the env path with the installer's path.
bun --env-file /absolute/path/to/gateway.env run ops/imsg-verify.ts
```

It uses the existing non-sending `probe` RPC: Messages history access exercises FDA; existing ensure/park UI automation exercises Messages/System Events AppleEvents and Accessibility. It does not select a user's conversation or send a message. `IMSG_URL` defaults to the loopback `http://127.0.0.1:4702/rpc`; set it to `https://imsg.hena.dev/rpc` to verify the authorized public route too. The gateway token is a dedicated credential distinct from Fleet/OpenCode. The probe does not prove attachment conversion or historical data completeness: verify a retained attachment and history through the gateway's normal read/image APIs before moving traffic, and reconcile messages received during the pause.

If delivery or the probe fails, inspect Fleet's profile status and the gateway launchd logs, binary paths and signatures; correct policy attribution and reapply. **Do not substitute manual TCC toggles.** Upload success is not a claim that this not-yet-enrolled Mac already has permissions.

## Export and restore Fleet on another Docker host

```sh
packages/api-msg.hena.dev/ops/mdm/fleet-data.sh export /absolute/protected/fleet-snapshot
# On a fresh checkout/deployment directory with no .env and empty volumes:
packages/api-msg.hena.dev/ops/mdm/fleet-data.sh restore /absolute/protected/fleet-snapshot
```

Export briefly stops Fleet/MySQL/Redis for a consistent cold snapshot, archives all three named volumes, and saves the setup `.env`, exact pinned Compose file and SHA-256 checksums. An exit trap restarts the stack even if export fails. The output directory must be new and is mode 0700; contents are mode 0600. **Encrypt and protect the snapshot**, including the Fleet API token/encryption key and all MDM certificate/private-key material; this is not a sanitized diagnostic artifact. Also preserve the Cloudflare Tunnel configuration/credentials and your protected APNs renewal records.

Restore verifies checksums and the pinned Compose file, requires explicit `RESTORE` approval, refuses an existing `.env` and refuses **any nonempty destination volume**. It does not wipe data. On the replacement host, retain the backed-up Compose image versions (use the snapshot's Compose file if the checkout differs); restore, verify health/admin login, certificate expiry and all profile records locally, then move the stable public tunnel address. Only one Fleet instance should serve the existing devices. Keep the old snapshot/host until MDM check-in and gateway probe succeed through the restored public address. Retaining Fleet's database, private key and public URL retains device enrollment; generating a new APNs identity does not.

For a replacement **Mac**, keep Fleet/Docker running: install the gateway, run the attended sign-in/enrollment stages, regenerate/apply policy from that Mac's binaries, wait for delivery, verify history/attachments and the launchd probe, then switch `imsg.hena.dev`. Do not blindly reuse the previous Mac's cdhash/path-based profile. Application intake/scheduling remains paused until history and uncertain sends are reconciled by the separate cutover procedure.

## Annual APNs renewal

Re-run the APNs stage or follow [Fleet's renewal instructions](https://fleetdm.com/guides/apple-mdm-setup#renew-apns): Edit Apple MDM > Renew certificate > Download CSR; at Apple's portal **Renew the SAME certificate with the SAME account**, verifying the Common Name matches Fleet; upload the new `.pem`. Renew before expiry, verify MDM check-in/profile delivery and export a new protected snapshot. Creating a replacement certificate/account can require every Mac to re-enroll.

Sources: [official Docker deployment](https://fleetdm.com/guides/deploy-fleet-on-docker-compose), [Apple MDM setup/manual enrollment](https://fleetdm.com/guides/apple-mdm-setup), [Fleet REST API](https://fleetdm.com/docs/rest-api/rest-api), [Apple PPPC payload](https://support.apple.com/guide/deployment/privacy-preferences-policy-control-payload-dep38df53c2a/web).
