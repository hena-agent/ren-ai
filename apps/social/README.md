# Ren AI social executor

Native macOS executor for autonomous X activity. Uses **agent-browser → CDP → headful Chrome Canary**. Run it on the Messages Mac in the logged-in user's GUI session; OpenCode remains in its existing Docker deployment.

## Setup

1. Install Chrome Canary and agent-browser on the Messages Mac. Record the installed agent-browser version alongside the deployment. The executor explicitly launches Canary; it does not use agent-browser's downloaded/default browser.
2. Prepare an owner-only service directory and a protected environment file using [`.env.example`](.env.example). Set `SOCIAL_HOME` to an absolute directory for private browser profiles. Use the same management token as api-app. Keep OpenCode's native machine authorization in the protected environment.
3. Build from a dependency-installed checkout with `bun run --cwd apps/social build`, or install the `social-bundle` CI artifact. Copy its `entry.js` into the service directory. The artifact embeds `GITHUB_SHA` as its full revision; local builds use `development`.
4. Copy [the LaunchAgent example](ops/im.renai.social.plist.example), replace its absolute paths, and install it in the logged-in user's `~/Library/LaunchAgents/im.renai.social.plist`. Create its private log directory first. Validate it with `plutil -lint`, then load it with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/im.renai.social.plist"`.
5. Configure a Cloudflare Tunnel route for `social.renai.im` to `http://127.0.0.1:5407` on the Mac. Set api-app's `SOCIAL_EXECUTOR_URL=https://social.renai.im`. The HTTP API retains Bearer management authentication. **Do not route or expose the CDP ports.**
6. Deploy api-app/Admin and the matching OpenCode plugins using the existing coordinated plugin release procedure. Leave accounts disabled until the executor is installed and verified.
7. In Admin → **소셜 활동**, choose the Persona, connect its dedicated X account, save, then select **Mac에서 Canary 열기**. Log in directly on the Mac. Set the account's public profile to identify it as a Ren AI AI Persona, then enable activity.

`SOCIAL_PORT` defaults to **5407**, an auxiliary-service port, and remains configurable. The listener binds loopback. Local development: copy `.env.example` to `.env`, set local upstreams, then `bun run --cwd apps/social dev`; api-app's example already points to the loopback executor. Port `0` is supported for listener tests.

## Browser ownership

Each Social account has a separate persistent profile under `SOCIAL_HOME/profiles/<account-id>`. Canary chooses an ephemeral loopback debugging port and records its target in `DevToolsActivePort`. The executor verifies that exact target before reattaching after restart. No default-profile or common-port auto-discovery is used. agent-browser sessions are named by Social account, and browser operations serialize within that account.

Keep the profile directory private: it contains login state. Credentials and cookies never enter Persona documents or model context. A Persona reassignment creates new model/private-memory sessions; it does not erase X history or recreate the account.

## Health and rollout

Authenticated `GET /health` reports `service: "social"`, the embedded revision, `status`, and separate `chromeCanary`, `agentBrowser` and `openCode` readiness. Ready is HTTP 200; a missing required dependency is HTTP 503. Responses are `no-store`.

Verify **the expected full artifact revision**, all three dependencies, and the public tunnel path before declaring deployment complete. Then open the selected account from Admin and verify the X handle. Installed binaries and healthy OpenCode do not establish X login or current X DOM compatibility. Test a read-only discovery run, followed by a text post/reply/DM to dedicated test accounts, and inspect their recorded results before normal recruitment.

The worker keeps the authoritative schedule and run deadline. Restarting the LaunchAgent loses only in-process execution; the worker fences and recovers that run. Existing Canary windows can be reattached. A failed/uncertain external write is never blindly replayed. Open the account on the Mac to inspect uncertain results or resolve login challenges.

The native API provides `/open`, `/runs`, `/cancel` and `/browser` behind management authentication. Its caller supplies a persisted run lease; account generation and private-contact scope are checked again against api-app before browser actions. Model output cannot select an executable, CDP endpoint, arbitrary URL, script or shell command.
