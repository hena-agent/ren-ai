# iMessage throughput verification

## Changes

- Intake checks the bookmark row and at most 100 new rows per heartbeat. Normal
  restarts and watch-overflow recovery resume from the bookmark instead of
  rescanning history. Database replacement still triggers recovery.
- A durable admission queue advances the bookmark atomically with queued rows.
  Admission runs across four Handles concurrently, preserves each Handle's order,
  admits at most 25 rows per Handle per pass, and backs failed Handles off for
  30 seconds. Prompt IDs and `intake_seen` preserve deduplication on restart.
- The Mac uses Node/Bun's built-in SQLite reader for indexed chat IDs and outgoing
  GUID/date metadata. Each lookup opens `chat.db` read-only, so database replacement
  cannot retain stale IDs. No message content is decoded by this reader; imsg still
  handles history, attachments, status and sending. Cold status lookups no longer
  build an index by decoding the entire Messages history.
- Recent history reads query the selected chat; the history limit grows until the
  window is complete. Heartbeat catch-up uses an optional protocol limit, tested
  against both the current and previous server schemas. Health probes read at most
  one row, and stream reconnect checks inspect only the bookmarked row.
- Gesture chat discovery starts with 100 recent chats and grows as needed, without
  the old 10,000-chat cutoff. Cached identities are verified through native
  `imsg group` metadata before each action; stale or invalid identities fail closed.
- Typing sends the entire draft through one AppleScript process. Focus is checked
  before every character; newline insertion and draft cleanup remain guarded.
- Native RPC replies have a 30-second deadline. A timed-out child is closed and
  later requests reconnect. Mutations are not automatically resent. UI operations
  have an overall 60-second budget, including queue wait; chat lookup and Tapback
  subprocesses have 15-second deadlines.
- Recovery inspects at most 20 Conversations per heartbeat, reserving up to ten
  slots for known failures. A durable circular cursor gives other Conversations
  eventual inspection across runtime restarts. Retry dispatch is also bounded.
- A currently in-flight send with a known GUID can settle through status lookup
  without fetching chat history. Crash/uncertain-send recovery retains historical
  reconciliation.
- Discovery selection fetches its catalog once, outside its transaction, and uses
  indexed in-memory lookups for Likes and persona availability. Rate limiting
  expires inactive IP entries, retains at most five admitted timestamps per IP,
  and caps tracked IPs at 10,000. Rejected attempts do not extend the window.
- Mac operations emit payload-free timings, queue depth/wait and failure metadata.

## Verification

`bun run ci` passed using the repository-required Bun 1.4.2:

- 1,322 tests passed after integration with current `main`.
- 100% statements, branches, functions and lines; 226 files fully covered.
- Formatting, lint, type checking, dead-code checks, duplication checks,
  exception reporting, Discovery build and gate enforcement checks passed.
- `git diff --check` passed.
- `osacompile` successfully compiled `messages-ui.applescript`.

Behavioral load regressions are included in the normal suite:

| Fixture                                | Verified result                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| 100,000 historical rows                | Idle intake returns one bookmark row rather than all history                          |
| 10,001 rows across many chats          | Conversation/status lookups make zero all-chat history-page requests                  |
| 100,001 rows in one chat               | Cold status finds the latest outgoing ROWID, including backdated messages             |
| 10,001 chats                           | Gesture discovery reaches the final chat and verifies cached identities before acting |
| 10,000-row backlog                     | A 100-row catch-up reads one native page instead of draining the backlog              |
| 1,000-character draft                  | One keystroke process rather than one per character                                   |
| 1,000 Conversations                    | 20 recovery inspections per heartbeat, durable fair traversal                         |
| Failed Handle with 100 queued messages | Another Handle progresses; pending messages survive runtime replacement               |
| 128 stalled RPC requests               | Requests fail, capacity recovers, and sends are not replayed                          |
| 1,000 waitlist registrations           | Selection uses one catalog fetch and exclusive persona reservations                   |
| 10,000 tracked IPs                     | Admission memory is bounded and expired entries release capacity                      |

Existing reset, replay, ordering, uncertain-send, delivery, and protocol tests also
pass. New diagnostics tests check failure metadata and private-input exclusion.

## Operational limits

These fixture results measure work reduction, not deployed messages per second.
The Messages UI remains a single global serialized resource. Typing duration still
occupies it, and queue waiting counts toward the requested duration.
Removing that ceiling requires changing the transport described in
[ADR 0005](../adr/0005-typing-read-receipts-and-tapbacks-go-through-the-messages-ui-while-sip-stays-on.md).
After reviewing the remaining ceiling and native measurements, the operator chose
to retain the SIP-on UI transport and merge these improvements with that limit.

First-ever bootstrap without a bookmark and exceptional full replay can still scan history. Recent-history
queries can grow with the selected chat's requested window. Edit monitoring still
polls watched Conversations, and contact listing/selection still materializes the
waitlist, now with linear lookups.

Recovery trades scan frequency for a bounded heartbeat budget: 1,000 Conversations
need 50 inspection rounds without priority failures, or approximately 100 seconds
at an ideal two-second heartbeat, plus operation time. With ten priority slots
occupied, a background round can take about twice as long.

### Live neutral UI follow-up

The initial no-send `ensure` and `park` probes timed out. Follow-up testing found
that the session lacked Accessibility access (`AXIsProcessTrusted()` returned
false). After the operator enabled it, UI queries still timed out with AppleEvent
error `-1712`; restarting System Events cleared that remaining failure.

On the real unlocked macOS desktop, using the worktree's `makeMessagesUi` adapter
with `NodeServices.layer` and actual `osascript` subprocesses:

- Three sequential `probe()` calls passed with no alerts: 324, 270 and 550 ms.
- Three concurrent `probe()` calls passed in 1,881 ms total. Logged queue waits
  were 1, 441 and 935 ms, exercising the shared UI semaphore.
- Parking focused Messages' neutral recipient field (`AXIdentifier = "To:"`),
  rather than a conversation composer.
- The actual script's `key` action rejected that recipient field with
  `composer is not focused` before typing.
- With Finder in front, `park` rejected the action with
  `Messages is not in front`; Finder retained focus.
- Cleanup successfully restored Messages to the neutral recipient field.

The operator selected **neutral UI checks only**. Conversation-level typing,
draft cleanup, read receipts, sends and Tapbacks remain unverified on the live UI.
No test conversation was selected and no messages were sent.

### Native synthetic load follow-up

The earlier 120-second timeout was cumulative full-scan cost. Instrumenting each
request showed that the first page completed in 0.36 seconds, but 500 pages of 100
rows took 111 seconds. With the maximum native page size of 500, a complete
100,000-message scan took **216.1 seconds** across 200 requests. This remains an
expensive bootstrap/replacement operation, not a normal heartbeat/status path.

Against a synthetic SQLite database with 100,000 messages and 1,000 chats, native
`imsg 0.15.9` and the actual worktree adapter running on Bun 1.4.2 verified:

- 100 native bookmark checks: **0.75–2.01 seconds** total across runs.
- 100 adapter outgoing-status checks, including cold metadata lookup:
  **99–290 ms** total across runs. The final run, concurrent with full CI, took 290 ms.
- Complete targeted history: 100 expected rows.
- Bounded adapter catch-up: exactly the expected final row.
- Native `imsg group` identity verification: matching ID, handle, iMessage service
  and direct-chat flag.

These are local synthetic measurements, not deployed send/typing throughput.
SQL query-plan inspection confirmed indexed chat lookup and descending message
lookup; message rows are not globally sorted to select the outgoing GUID.
