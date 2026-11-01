# RenAI social executor

Native macOS executor for autonomous X activity. Uses **agent-browser → CDP → headful Chrome Canary**. Run it on the Messages Mac in the logged-in user's GUI session; OpenCode remains in its existing Docker deployment.

## Setup

1. Install Chrome Canary and **agent-browser 0.41.0** on the Messages Mac (for example, `bun add --global agent-browser@0.41.0`). Set `SOCIAL_AGENT_BROWSER` to its installed executable. A native binary such as the package's `bin/agent-browser-darwin-arm64` needs no Node wrapper; when using the JavaScript launcher, make Node 24 available in the LaunchAgent's PATH. The executor explicitly launches Canary; it does not use agent-browser's downloaded/default browser.
2. Prepare an owner-only service directory and a protected environment file using [`.env.example`](.env.example). Set `SOCIAL_HOME` to an absolute directory for private browser profiles. Use the same management token as api-app. Keep OpenCode's native machine authorization in the protected environment.
3. Build from a dependency-installed checkout with `bun run --cwd apps/social build`, or install the `social-bundle` CI artifact. Copy its `entry.js` into the service directory. The artifact embeds `GITHUB_SHA` as its full revision; local builds use `development`.
4. Copy [the LaunchAgent example](ops/im.renai.social.plist.example), replace its absolute paths, and install it in the logged-in user's `~/Library/LaunchAgents/im.renai.social.plist`. Create its private log directory first. Validate it with `plutil -lint`, then load it with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/im.renai.social.plist"`.
5. Configure a Cloudflare Tunnel route for `social.renai.im` to `http://127.0.0.1:5407` on the Mac. Set api-app's `SOCIAL_EXECUTOR_URL=https://social.renai.im`. The HTTP API retains Bearer management authentication. **Do not route or expose the CDP ports.**
6. Deploy api-app/Admin and the matching OpenCode plugins using the existing coordinated plugin release procedure. Leave accounts disabled until the executor is installed and verified.
7. In Admin → **소셜 활동**, choose the Persona and enter its dedicated X account, login ID (email, phone or username), and password in the same connection form, then select **연결하고 로그인**. This saves the connection and starts login on the Mac. Existing connections use the same form to replace both login fields; leaving both empty saves settings without changing credentials. If the connection saves but login submission fails, Admin retains the connection and asks for fresh credential input. Refresh the login status; enter a verification code when requested. **Mac에서 Canary 열기** remains available for CAPTCHA and other manual challenges. Set the account's public profile to identify it as a RenAI AI Persona, then enable activity.

`SOCIAL_PORT` defaults to **5407**, an auxiliary-service port, and remains configurable. The listener binds loopback. Local development: copy `.env.example` to `.env`, set local upstreams, then `bun run --cwd apps/social dev`; api-app's example already points to the loopback executor. Port `0` is supported for listener tests.

## Browser ownership

Each Social account has a separate persistent profile under `SOCIAL_HOME/profiles/<account-id>`. Canary chooses an ephemeral loopback debugging port and records its target in `DevToolsActivePort`. The executor verifies that exact target before reattaching after restart. No default-profile or common-port auto-discovery is used. agent-browser sessions use stable hashes of Social account IDs. Private, short socket directories under `/tmp` avoid macOS's 103-byte Unix socket limit even with long service paths. Authentication and browser actions share the account's serial queue.

Keep the profile directory private: it contains login state. Credentials and cookies never enter Persona documents or model context. A Persona reassignment creates new model/private-memory sessions; it does not erase X history or recreate the account.

## Credentials and automatic re-login

The Admin/API forward credential requests directly to the authenticated Mac endpoint without persisting their bodies. The Mac uses agent-browser's encrypted v1 auth vault under `SOCIAL_HOME/agent-browser/.agent-browser/auth`, bound to the expected X handle. No login ID, password or code enters process arguments or model context. Browser input uses stdin; secret-bearing command output is discarded. Login IDs are not returned by status APIs or written to application logs. Never put credentials in activity instructions.

agent-browser's generic `auth login` expects both fields on one form, and `auth save` takes its username through argv. The executor therefore reads and writes the pinned CLI's encrypted vault format with Node's standard AES-256-GCM implementation and runs a bounded X login flow. Key creation is atomic and exclusive across accounts; profiles use fresh IVs and owner-only atomic writes. Only stage metadata leaves the login reader. The private input operation checks X's HTTPS origin and login route synchronously before setting a connected input. There is no plaintext-profile compatibility path. Unsupported CLI versions are rejected before credentials are saved, and health reports the dependency as unavailable.

Back up the protected vault **and** its auto-generated `.encryption-key` in that same agent-browser directory; alternatively supply `AGENT_BROWSER_ENCRYPTION_KEY` as an operator-managed 64-character hex secret. Do not set that optional variable to an empty value.

Expired sessions trigger one automatic login attempt before the original social action. Wrong credentials, CAPTCHA and code challenges pause further activity instead of repeatedly retrying. Admin can replace credentials, retry/check a login, submit a one-time code, or remove saved credentials and stop activity. Removing saved credentials does not erase the X account's posts, messages or existing browser cookies. A login never enables a previously disabled account.

The worker persists finite login-recovery probes while a submitted login is in progress; callback loss and actor replacement do not lose its wake. Codes/manual attention stop those probes. An interrupted Mac login is surfaced for explicit retry. Only definitely pre-submit authentication failures release an unsent write reservation; any authentication interruption after clicking submit remains uncertain and deduplicated.

## Health and rollout

Authenticated `GET /health` reports `service: "social"`, the embedded revision, `status`, and separate `chromeCanary`, `agentBrowser` and `openCode` readiness. Ready is HTTP 200; a missing required dependency is HTTP 503. Responses are `no-store`.

Verify **the expected full artifact revision**, all three dependencies, and the public tunnel path before declaring deployment complete. Then open the selected account from Admin and verify the X handle. Installed binaries and healthy OpenCode do not establish X login or current X DOM compatibility. Test a read-only discovery run, followed by a text post/reply/DM to dedicated test accounts, and inspect their recorded results before normal recruitment.

The worker keeps the authoritative schedule and run deadline. Restarting the LaunchAgent loses only in-process execution; the worker fences and recovers that run. Existing Canary windows can be reattached. A failed/uncertain external write is never blindly replayed. Open the account on the Mac to inspect uncertain results or resolve login challenges.

The native API provides `/auth`, `/open`, `/runs`, `/cancel` and `/browser` behind management authentication. Login inputs are a separate transient contract, never SocialAccount or model-task fields. Browser callers supply a persisted run lease; account generation and private-contact scope are checked again against api-app before browser actions. Model output cannot select an executable, CDP endpoint, arbitrary URL, script, shell command or credential action.
