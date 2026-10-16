# api-msg Mac executor

`api.renai.im` is the DB-free authenticated executor on the current Messages
Mac. It listens on loopback port 4700 and forwards fixed OpenCode and imsg
upstreams. It does not own application state, credentials for Turnstile, a local
database, or a second Messages gateway. The separate existing `imsg.renai.im`
and `oc.renai.im` processes, tunnels and upstreams remain unchanged.

## One-time provisioning

Use the GUI Mac user, never root. Set `API_MSG_HOME` only to a new absolute
path; the default service identity is `/usr/local/lib/ren-ai-api-msg`.

1. In Cloudflare, create a **separate** tunnel and public hostname
   `api.renai.im` → `http://127.0.0.1:4700`. Do not reuse or edit the imsg
   tunnel or the OpenCode ingress.
2. Set api-app's private `API_MSG_URL=https://api.renai.im` and
   `TOKEN_MANAGEMENT` secret. Reuse the existing token in a protected copy of
   [`api-msg.env.example`](api-msg.env.example); also provide the existing
   native OpenCode authorization header and imsg token. No secret belongs in
   the plist, command line or logs.
3. After `main` CI publishes `api-msg-bundle`, install the **attested** latest
   main artifact and create the executor LaunchAgent without starting it:

   ```sh
   cd apps/api-msg
   bash ops/install-from-ci.sh /absolute/private/api-msg.env
   ```

   This downloads only the `api-msg-bundle` artifact from the latest completed
   `main` push run and verifies the workflow, source ref, exact source digest
   and GitHub-hosted runner provenance before installation. The installed Bun
   is the existing reviewed Bun at `$IMSG_HOME/bin/bun` (default
   `/usr/local/lib/ren-ai-messaging/bin/bun`). The installer refuses to replace
   an existing home or LaunchAgent.

4. Install the tunnel as a separate LaunchAgent, also without starting it:

   ```sh
   bash ops/install-tunnel.sh /absolute/reviewed/cloudflared /absolute/private/api-msg-tunnel-token
   ```

   The raw token file belongs only to the separate tunnel process. The script
   never changes Cloudflare dashboard configuration or starts a tunnel.

5. Bootstrap `im.renai.api-msg` and `im.renai.api-msg-tunnel` explicitly only
   after reviewing their plists and confirming the configured hostname/origin.
   Run the local authenticated no-send health probe:

   ```sh
   ROOT="${API_MSG_HOME:-/usr/local/lib/ren-ai-api-msg}"
   "$ROOT/bin/bun" --env-file="$ROOT/api-msg.env" "$ROOT/api-msg-verify.js"
   ```

   The probe validates HTTP 200 and the two boolean fields
   `diskNearlyFull`/`screenLocked`; it does not print or save the response body.

## Automatic updates

`GET /health` retains Bearer authentication and reports `service: "api-msg"`, the
full source `revision` embedded by CI, and `status`. A locked screen, nearly-full
disk or failed Mac health check returns `degraded` with HTTP 503; ready returns 200. Local source runs use revision `development`. Responses are never cached.
The bundled probe requires this identity, its own artifact revision and readiness.

After the gateway is verified, provision the updater once. Create a fine-grained
GitHub token for `hena-agent/ren-ai` with read-only Actions and Attestations
permissions only. Keep the raw token in an owner-only file, then install the
deploy LaunchAgent without loading it:

```sh
cd apps/api-msg
bash ops/install-deploy-agent.sh /opt/homebrew/bin/gh /absolute/private/raw-github-token
```

The `im.renai.api-msg-deploy` agent polls every two minutes. It accepts only the
attested `api-msg-bundle` from the latest completed `main` CI push and verifies
the workflow identity, `refs/heads/main`, exact commit digest and hosted-runner
provenance. It probes the currently installed process first, installs only the
JavaScript payload, and restarts only `im.renai.api-msg` when executable payload
files change, including the embedded revision. Failed probes restore the
previous payload; a bad artifact is marked rejected if the prior service was
healthy, otherwise it is deferred until the Mac recovers. The updater never
modifies `api-msg.env`, Bun, either upstream, the imsg process or any tunnel.

The source imsg updater uses the same `apps/imsg/ops/deploy-helper.sh` under its
`imsg` profile. An already-installed imsg updater is not changed by this work;
its current deployment continues independently. The new api-msg updater gets
the shared helper under its `api-msg` profile during first provisioning. If the
operator chooses to move an existing imsg updater to the helper, its updater
files can be copied separately as described in the [imsg runbook](../../imsg/ops/README.md#automatic-deployment); that does not restart imsg.

The api-msg listener is configured on port 4700, replacing the retired local
application listener contract. Verify that the old application intake is
paused and imported centrally before enabling api-app intake. Provisioning or
updating this executor does not enable application intake or send messages.

## Local development

From the repository root, `bun dev` includes `@ren-ai/api-msg#dev` alongside
`@ren-ai/api-app#dev`. The executor listens at `http://127.0.0.1:4700`;
export `API_MSG_PORT` to change it and update api-app's `API_MSG_URL` accordingly.

Copy `apps/api-msg/.env.example` to `apps/api-msg/.env`. Bun loads `.env`
automatically during development; keep credentials out of Git.
Export `TOKEN_MANAGEMENT`, `OPENCODE_URL`, `OPENCODE_AUTHORIZATION`, `IMSG_URL`,
and `IMSG_TOKEN` to override them. `TOKEN_MANAGEMENT` must match api-app and the OpenCode plugin environment.
The default upstreams are local OpenCode at `http://127.0.0.1:4096` and imsg
at `http://127.0.0.1:4702/rpc`; these must be running for execution requests.
`bun dev` starts the gateway, not the upstream OpenCode or Messages services.
Production `start` continues requiring explicitly supplied credentials.
