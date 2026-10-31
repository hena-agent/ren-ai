# Persona social activity — X

## Operator workflow

1. Open **소셜 활동** in Admin, or **이 페르소나에 소셜 계정 연결** in a Persona's editor.
2. Enter the X handle and select the Persona that account represents. Supply an existing invitation code, activity instructions, timezone, active hours, interval, per-run duration and daily judgment/write limits.
3. Save while activity is disabled. Open Canary from Admin; on the Messages Mac, log into the dedicated X account and complete any login challenges.
4. Enable activity. Within the configured window it autonomously discovers people, publishes text posts, replies, reads private conversations and sends DMs or invitations. **지금 실행** brings the next eligible check forward; it does not override the activity window or daily limits.
5. Inspect bounded, paginated activity history and follow confirmed post URLs. Stop activity or change the connected Persona from Admin.

Changing the Persona or X handle fences the current run, cancels that specific execution and increments the private-session generation. Pausing and resuming the same connection preserves its sessions and memory. The existing X account's posts and DMs remain on X.

## Autonomous discovery and conversation

The Persona uses her current identity and shared life. Operator instructions describe the audience and objective, not another personality. Start by checking existing notifications/conversations, then find public posts from actual AI-companion users. The model chooses whether to reply, continue a private conversation, post independently or offer the supplied invitation.

Each model judgment returns one schema-validated decision and a bounded reason. Fixed browser actions execute through agent-browser. Only fixed DOM readers run JavaScript. A failed CLI command is a failure even if its process exits successfully. Navigation checks the logged-in handle; writes revalidate the durable run immediately before clicking send.

Public browsing, public posts and replies use the public session. `contact` switches to a separate private session; a short `publicContext` may accompany a public-to-private transition. Private-to-public/contact transitions discard that context. Inbox discovery returns contact metadata without message previews. Private scope permits only its messages, DMs, scope changes and finishing.

State and Life memory are shared with iMessage. Social private memory belongs only to the account's current Persona and that contact handle. No social session can use iMessage sending, waiting or photo tools. Existing conversations do not receive browser tools or social private memory.

## Durable execution

`SocialActivity` stores accounts, per-account running leases, turn reservations, action events and target deduplication in SQLite. Due work uses indexed time predicates and SQL limits. Scope history uses an account/contact/id index and a fixed ten-row window. Admin history uses an id cursor and fifty-row limit. Idle checks do not rewrite unchanged schedules.

Daily limits use the account's local date. Judgment reservations are idempotent for a run/step, and write attempts consume the write allowance before I/O, including uncertain attempts. The judgment limit counts host decisions, not every internal memory-tool model step. Per-run wall-clock deadlines also bound model work. Exhausted judgment budgets schedule the next local day's activity window.

Runs are durably recorded before dispatch; the Mac acknowledges promptly. A persisted deadline recovers interrupted execution. Completion schedules the next window. Login problems show `login_required`; the Operator can open the managed Canary profile and resolve them.

Completed action replays return their receipts. In-flight duplicate submissions do not call the browser again. Posts require a new matching status owned by the account; DMs require new visible message content. A timeout or missing evidence becomes uncertain rather than success. Uncertain write targets remain deduplicated across actor/executor replacement. Inspect X directly before taking manual action; no automatic resend or receipt reset is offered.

## Invitations and privacy

The Operator selects an existing invitation code. Exact availability checks use the existing authoritative invitation ledger, independently of recent-code listings. The Persona explains that it invites someone to Ren AI; the recipient chooses through the existing flow. No same-Persona assignment, instant first message, or cross-channel recognition is promised.

Admin's authenticated history may show social content and discovery observations. Diagnostic logs contain request/operation IDs, stages, outcomes, safe cause codes and stack frames, never prompts, message bodies, invitation codes, cookies or authorization headers.

## Deployment and verification

See [Messages Mac social executor](../../apps/social/README.md). Deploy the coordinated session-folder, application and context plugin changes before enabling social activity. Verify ordinary iMessage tools still work and social sessions lack them. Install the exact executor artifact revision and verify its authenticated health with all required dependencies ready. Publishing the artifact does not prove Mac installation, browser login or X DOM compatibility.
