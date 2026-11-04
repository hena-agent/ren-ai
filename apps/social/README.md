# RenAI social executor

Native macOS executor for autonomous Threads and X activity. Uses **agent-browser → CDP → headful Chrome Canary**. Run it on the Messages Mac in the logged-in user's GUI session; OpenCode remains in its existing Docker deployment.

## Setup

1. Install Google Chrome Canary on the Messages Mac and provision [api-msg](../api-msg/ops/README.md). Its attested bundle includes `social.js` with the same full source revision as the gateway. The installer copies native Bun 1.4.4, installs agent-browser **0.41.0** without lifecycle scripts, and writes the native GUI LaunchAgent. The social executor shares api-msg's protected environment, management token and OpenCode authorization.
2. Native browser profiles and encrypted credentials live in api-msg's owner-only `social-state` directory. The Docker gateway does not mount that directory or the protected environment into its image.
3. Start the native service with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/im.renai.social.plist"` before starting the Docker gateway. api-msg's existing updater replaces and rolls back both bundles and restarts the native executor with the gateway.
4. API social requests use the existing `API_MSG_URL` and `/social/*` gateway routes. The gateway forwards only fixed supported paths to the native Mac executor; there is no separate public social hostname or tunnel. Docker uses `http://host.docker.internal:5407`; verify the container can reach the Mac's loopback listener. **Do not route or expose the CDP ports.**
5. Verify both gateway `/health` and authenticated `/social/health` through `API_MSG_URL`. The gateway reports degraded if its native social dependency is unavailable, unready or running another revision.
6. Deploy api-app/Admin and the matching OpenCode plugins using the existing coordinated plugin release procedure. Leave accounts disabled until the executor is installed and verified.
7. In Admin → **소셜 활동**, open the **Threads** or **X** tab (Threads by default). The tab scopes accounts, form fields, login status and activity; no platform dropdown is needed. Choose the Persona and enter login ID and password, then select **연결하고 로그인**. The actual account handle is discovered automatically after login. Threads uses Instagram credentials. The Mac saves encrypted credentials first, then starts browser login. Browser or login failure retains those credentials; use **저장된 정보로 로그인 재시도** without re-entering secrets. Existing connections use the same form to replace both login fields; leaving both empty saves settings without changing credentials. If the Mac credential submission itself fails, Admin retains the connection and asks for fresh input. Refresh status; enter a verification code when requested. **Mac에서 Canary 열기** remains available for manual challenges. Set the account's public profile to identify it as a RenAI AI Persona, then enable activity.

`SOCIAL_PORT` defaults to **5407**, an auxiliary-service port, and remains configurable. The listener binds loopback. Local development: copy `.env.example` to `.env`, set local upstreams, then `bun run --cwd apps/social dev`; native api-msg defaults to that loopback executor, and api-app uses its existing gateway URL. Port `0` is supported for listener tests. Standalone development builds remain available with `bun run --cwd apps/social build`.

## Browser ownership

Each Social account has a separate persistent profile: X under `SOCIAL_HOME/profiles/<account-id>`, Threads under `SOCIAL_HOME/profiles/threads:<account-id>`. Canary chooses an ephemeral loopback debugging port and records its target in `DevToolsActivePort`. The executor verifies that exact target before reattaching after restart. No default-profile or common-port auto-discovery is used. agent-browser sessions use stable hashes of these platform-specific ownership keys. Private, short socket directories under `/tmp` avoid macOS's 103-byte Unix socket limit even with long service paths. Authentication and browser actions share the account's serial queue.

Keep the profile directory private: it contains login state. Credentials and cookies never enter Persona documents or model context. A Persona reassignment creates new model/private-memory sessions; it does not erase X history or recreate the account.

## Credentials and automatic re-login

Use Admin's **로그인 상태 확인** to check the live browser session before logging in again. It requires no saved password, never enters credentials, and verifies the logged-in handle. Existing matching sessions are reused by login requests as well. An old login form is refreshed via the platform home before deciding whether login is needed; a verification/CAPTCHA screen is preserved for operator handling. The status-refresh link only reads the last result. Checks have their own waiting state, stay serialized with browser work, and do not cancel active social execution. A successful manual-login check resumes only an eligible login-paused account; failure is not reported as confirmed logout.

Admin does not ask for an account handle. New connections remain unidentified until the first successful login or live-session check reads the platform identity. The handle is then persisted and displayed read-only; activity stays blocked until it is known. The Mac retains the discovered binding across restart and callback loss, including for saved credentials, and subsequent checks reject another account. Initial discovery preserves the internal connection ID and generation. Missing identities and duplicate same-platform connections cannot be adopted.

The Admin/API forward credential requests directly to the authenticated Mac endpoint without persisting their bodies. The Mac uses agent-browser's encrypted v1 auth vault under `SOCIAL_HOME/agent-browser/.agent-browser/auth`, bound to the selected platform and expected handle. No login ID, password or code enters process arguments or model context. Browser input uses stdin; secret-bearing command output is discarded. Login IDs are not returned by status APIs or written to application logs. Never put credentials in activity instructions.

agent-browser's generic `auth login` expects both fields on one form, and `auth save` takes its username through argv. The executor therefore reads and writes the pinned CLI's encrypted vault format with Node's standard AES-256-GCM implementation. X uses a bounded multi-step flow; Threads fills its Instagram username and password together in one private stdin batch. Key creation is atomic and exclusive across accounts; profiles use fresh IVs and owner-only atomic writes. Only stage metadata leaves the login reader. Private input synchronously checks the selected platform's exact HTTPS origin and login route. Credential saving requires neither Canary nor the CLI; unsupported CLI versions fail login while preserving credentials, and health reports the dependency as unavailable.

Threads and X use separate browser ownership keys and vault names, including identical account IDs. Existing X profiles retain their ownership. Threads supports public search, profiles, posts and replies; notifications, private scope and DMs are unavailable and rejected before send reservations. Cross-platform post URLs are rejected. Both platforms verify a new owned permalink after a public write; a missing receipt stays uncertain.

Back up the protected vault **and** its auto-generated `.encryption-key` in that same agent-browser directory; alternatively supply `AGENT_BROWSER_ENCRYPTION_KEY` as an operator-managed 64-character hex secret. Do not set that optional variable to an empty value.

Expired sessions trigger one automatic login attempt before the original social action. Wrong credentials, CAPTCHA and code challenges pause further activity instead of repeatedly retrying. Admin can replace credentials, retry/check a login, submit a one-time code, or remove saved credentials and stop activity. Removing saved credentials does not erase the X account's posts, messages or existing browser cookies. A login never enables a previously disabled account.

The worker persists finite login-recovery probes while a submitted login is in progress; callback loss and actor replacement do not lose its wake. Codes/manual attention stop those probes. An interrupted Mac login is surfaced for explicit retry. Only definitely pre-submit authentication failures release an unsent write reservation; any authentication interruption after clicking submit remains uncertain and deduplicated.

## Health and rollout

`bun run --cwd apps/social test:browser` exercises the production browser actions
through real agent-browser **0.41.0** and isolated headless Chrome. Set
`SOCIAL_TEST_AGENT_BROWSER` and `SOCIAL_TEST_CHROME` to their executable paths.
CI runs this check against local HTML fixtures: hidden mobile navigation,
loading overlays, the current Threads composer, translation controls and X
recipient selection. It uses temporary profiles and a loopback server on port 0;
no platform login or external publication is involved.

Authenticated `GET /health` reports `service: "social"`, the embedded revision, `status`, and separate `chromeCanary`, `agentBrowser` and `openCode` readiness. Ready is HTTP 200; a missing required dependency is HTTP 503. Responses are `no-store`.

Verify **the expected full artifact revision**, all three dependencies, and the authenticated gateway path before declaring deployment complete. Then open the selected account from Admin and verify its handle. Installed binaries and healthy OpenCode do not establish platform login or current DOM compatibility. Test a read-only discovery run, followed by a text post/reply (and X-only DM) to dedicated test accounts, and inspect their recorded results before normal recruitment.

The worker keeps the authoritative schedule and run deadline. Restarting the LaunchAgent loses only in-process execution; the worker fences and recovers that run. Existing Canary windows can be reattached. A failed/uncertain external write is never blindly replayed. Open the account on the Mac to inspect uncertain results or resolve login challenges.

The native API provides `/auth`, `/open`, `/runs`, `/cancel` and `/browser` behind management authentication. Login inputs are a separate transient contract, never SocialAccount or model-task fields. Browser callers supply a persisted run lease; account generation and private-contact scope are checked again against api-app before browser actions. Model output cannot select an executable, CDP endpoint, arbitrary URL, script, shell command or credential action.
