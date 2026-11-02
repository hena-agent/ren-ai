# Persona social activity — Threads and X

## Operator workflow

1. Open **소셜 활동** in Admin, or **이 페르소나에 소셜 계정 연결** in a Persona's editor.
2. Use the top-level **Threads / X tabs** (Threads opens by default). Each tab shows only its platform's connected accounts, connection form, login status and activity entries. Platform-specific field labels and handle rules are fixed by the active tab, with no platform dropdown inside the form. Account links, submissions, retries and history pagination retain that tab; cross-platform submissions are rejected. Enter the handle and choose the Persona that account represents. Supply a signup invitation code, activity instructions, timezone, active hours, interval, per-run duration and daily judgment/write limits. Threads handles may contain dots and up to 30 characters; X keeps its 15-character handle rules.
3. Enter login ID and password in that same form and save while activity is disabled. Threads uses the account's Instagram credentials. The Mac encrypts and saves credentials **before** launching Canary or checking the browser CLI. Browser startup, CLI incompatibility, rejected passwords and verification challenges leave saved credentials intact. Admin distinguishes saved information from login outcome; **저장된 정보로 로그인 재시도** explicitly retries without another credential submission, including after executor replacement. Submit a one-time code when requested and use Canary for manual challenges. A failed attempt never causes an automatic retry loop.
4. Enable activity. Within the configured window Threads discovers public conversations, publishes text posts and replies. X additionally supports notifications and scoped private conversations/DMs. Threads notification and private-message actions are withheld from the model's supported actions and rejected before reservations at both API and Mac boundaries. **지금 실행** brings the next eligible check forward; it does not override the activity window or daily limits.
5. Inspect bounded, paginated activity history and follow confirmed post URLs. Stop activity or change the connected Persona from Admin.

**로그인 상태 확인** inspects the account's actual managed browser session without reading saved credentials or filling/clicking login controls. It works for manually logged-in accounts with no stored password. New connections can use **연결하고 로그인 상태 확인** with the account settings but no ID/password; connecting and attempting login still requires both credential fields. A verified matching account is reused, including for normal login requests, instead of opening the login form again. If an old login page is still open, a fixed navigation to the platform home refreshes cookie-based session state first. Logged-out, additional-authentication, wrong-account and unavailable-browser outcomes remain distinct. Ordinary status refreshes read the last result and never drive browser navigation. Live checks serialize with browser work but do not cancel a running social execution; verified manual login can resume a login-paused schedule while preserving the enabled preference. Interrupted checks remain explicitly retryable after restart.

The requested platform tab is resolved before any Persona-store or social API read. A failed read retains the selected tab and its connection form and reports unavailable account/history data, rather than claiming there are no accounts or silently selecting Threads.

Changing the Persona, platform or handle fences the current run, cancels that specific execution and increments the private-session generation. Pausing and resuming the same connection preserves its sessions and memory. Existing X connections stay X; adding a Threads connection does not convert or delete them. Same-name accounts on different platforms are distinct. Browser profiles, encrypted credential profiles and saved authentication statuses are platform-isolated, even for the same account ID.

## Autonomous discovery and conversation

The Persona uses her current identity and shared life. Operator instructions describe the audience and objective, not another personality. Start by checking existing notifications/conversations, then find public posts from actual AI-companion users. The model chooses whether to reply, continue a private conversation, post independently or offer the supplied invitation.

Each model judgment returns one schema-validated decision and a bounded reason. Fixed browser actions execute through agent-browser. Only fixed DOM readers run JavaScript. A failed CLI command is a failure even if its process exits successfully. Navigation checks the logged-in handle; writes revalidate the durable run immediately before clicking send.

Public browsing, public posts and replies use the public session. `contact` switches to a separate private session; a short `publicContext` may accompany a public-to-private transition. Private-to-public/contact transitions discard that context. Inbox discovery returns contact metadata without message previews. Private scope permits only its messages, DMs, scope changes and finishing.

State and Life memory are shared with iMessage. Social private memory belongs only to the account's current Persona and that contact handle. No social session can use iMessage sending, waiting or photo tools. Existing conversations do not receive browser tools or social private memory.

## Durable execution

`SocialActivity` stores accounts, per-account running leases, turn reservations, action events and target deduplication in SQLite. Due work uses indexed time predicates and SQL limits. Scope history uses an account/contact/id index and a fixed ten-row window. Admin history uses an id cursor and fifty-row limit. Idle checks do not rewrite unchanged schedules.

Daily limits use the account's local date. Judgment reservations are idempotent for a run/step, and write attempts consume the write allowance before I/O, including uncertain attempts. The judgment limit counts host decisions, not every internal memory-tool model step. Per-run wall-clock deadlines also bound model work. Exhausted judgment budgets schedule the next local day's activity window.

Runs are durably recorded before dispatch; the Mac acknowledges promptly. A persisted deadline recovers interrupted execution. Completion schedules the next window. An expired session attempts automatic re-login before continuing its original navigation. Login problems pause the schedule until current-account authentication is verified. Login callbacks have persisted, bounded recovery probes; code/manual attention and failed credentials stop retries. See [ADR-0028](../adr/0028-social-authentication-keeps-credentials-on-the-mac.md).

Completed action replays return their receipts. In-flight duplicate submissions do not call the browser again. Posts require a new matching permalink owned by the account, on that platform; Threads reply receipts are read from the account's Replies tab. X DMs require new visible message content. A timeout or missing evidence becomes uncertain rather than success. Uncertain write targets remain deduplicated across actor/executor replacement. Inspect the platform directly before taking manual action; no automatic resend or receipt reset is offered.

## Invitations and privacy

The Operator selects an existing invitation code. Exact availability checks use the existing authoritative invitation ledger, independently of recent-code listings. The Persona explains that it invites someone to RenAI; the recipient chooses through the existing flow. No same-Persona assignment, instant first message, or cross-channel recognition is promised.

Admin's authenticated history may show social content and discovery observations. Diagnostic logs contain request/operation IDs, stages, outcomes, safe cause codes and stack frames, never prompts, message bodies, invitation codes, cookies or authorization headers.

## Deployment and verification

See [Messages Mac social executor](../../apps/social/README.md). Deploy the coordinated session-folder, application and context plugin changes before enabling social activity. Verify ordinary iMessage tools still work and social sessions lack them. Install the exact executor artifact revision and verify its authenticated health with all required dependencies ready. Publishing the artifact does not prove Mac installation, browser login or X DOM compatibility.

Cloudflare uses its existing `API_MSG_URL` and management authentication for
`/social/*`, alongside `/opencode/*` and `/imsg/rpc`. The gateway accepts only fixed
social routes and forwards them to the Mac-local native listener. Its attested
bundle and updater include the native executor, whose LaunchAgent shares the
gateway's private environment. Gateway health reports social readiness separately
and requires the same artifact revision. Browser profiles and the encrypted vault
remain native Mac state; no additional public social hostname/tunnel is required.
