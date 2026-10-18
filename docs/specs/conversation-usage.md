# Conversation token accounting

The API application records OpenCode-reported usage in its own SQLite database. This is operational accounting, not credit charging or creator settlement.

## Collection and turn boundaries

Each execution heartbeat reads every bound session's complete, paginated `message.list` history in native sequence order, followed by `session.get`. OpenCode's persisted `idle` messages delimit turns: all steps since the previous idle marker belong to one turn, including new prompts delivered while the session was busy. Shutdown does not end a turn. The first user, synthetic, assistant or compaction message after an idle marker supplies the stable turn ID. Historical imports without an initial user message can still be grouped.

Collection upserts by native message ID in one application transaction. A failed page, cyclic cursor, unavailable executor or interrupted collection leaves the previous snapshot intact and marks the session unavailable. Repeating a snapshot or restarting the application cannot add duplicate usage. Running steps are refreshed until their final values arrive. A completed turn whose step has no terminal measurement retains an `unmeasured` entry with nullable counters, not invented zero usage.

The execution heartbeat collects usage after its other lifecycle work. Before removing a bound OpenCode session, the application requires a successful final usage snapshot. Collection failure prevents that removal. Session bindings are captured at creation and replacement; recorded usage is not cascade-deleted by a reset or user removal. Retained/replaced sessions continue to be collected. Existing conversations are bound when the schema is installed.

## Stored detail

- Conversation binding, persona ID, native session, turn and message IDs.
- Step source (`primary` or `compaction`), provider, model and variant where supplied.
- Native start and completion timestamps, outcome, finish reason, safe error type and upstream status.
- Separate non-cached input, visible output, reasoning, cache-read and cache-write counters, preserving OpenCode's normalized meanings. Reasoning is not added to output a second time.
- OpenCode's estimated USD cost. This is not an invoice, and subscription-backed usage may have a zero estimate.
- Snapshot time, source message count and collection availability.

No message bodies, summaries, prompts, tool payloads, provider state, credentials or handles are copied into accounting records. Queries and failures use the existing authenticated operator boundary and structured diagnostics.

## Memory compaction

The Memory plugin supplies the persona's first-person, four-part Memory instructions and current State/Memory to the ordinary compaction request. It no longer calls the text-only `session.generate` API, whose usage is absent from persisted session accounting in OpenCode 2.0.19.

OpenCode executes the summary and stores its measured tokens and cost on the compaction message. Its summary validator requires a native heading, so the four parts are enclosed by `## Important Context`; the system instruction overrides the generic coding checkpoint template. Empty/nonconforming summaries fail through the native compaction path. State/Memory files are not replaced by the checkpoint.

## Session reconciliation and limitations

The sum of known primary and compaction entries is reconciled against the native session totals. The signed difference is stored once as `session-overhead`, without inventing a model or turn attribution. This includes otherwise unattributed work such as title generation. It can also reflect imported/deleted history, missing measurements, or a moving session during the two API reads; it must not be treated as a newly measured model call. Subsequent snapshots refresh the difference. Summing all rows reproduces the latest observed native session total.

Tokens never reported/persisted by OpenCode cannot be reconstructed. In particular, previous Memory summaries made through `session.generate` remain unmeasured; changing the plugin meters future summaries, not old ones. Retry attempts are not tracked separately. A reported zero remains a reported zero; nullable counters indicate missing per-message measurements. An unavailable session keeps its last successful snapshot.

## Private query

`GET /management/conversations/:id/usage` uses the existing management Bearer authentication. It reads application SQLite only and does not start the executor. Responses carry `Cache-Control: no-store` and `X-Request-ID`.

The response includes session collection status, conversation-wide totals grouped by source/provider/model/variant, unattributed reconciliation rows, and the newest 50 turns with per-turn totals and detailed steps. `nextBefore` is the opaque numeric page boundary for `?before=...`; totals always cover the whole conversation. Session replacement remains attached to the same conversation. Reset usage remains in the private accounting tables and state export, even after the live conversation has been removed.

All three usage tables participate automatically in application state snapshots and restores. Rollout requires deploying the API application and Memory plugin together to begin metering the new summary path.
