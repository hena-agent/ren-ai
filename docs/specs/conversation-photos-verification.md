# Conversation photos: production verification

## 2026-10-26

Implementation: [PR #161](https://github.com/hena-agent/ren-ai/pull/161), merged as
`9c18944c39b97b54d1315a64ee6592d6c5e38e3b`.

### Automated evidence

- Full `bun run ci`: 401 files, 1,885 tests; 100% per-file coverage; static gates
  and gate self-checks passed.
- Native checks: 49 unit tests and two CLI tests passed.
- PR workflow `40283264515` passed every required check.
- Main workflow `40284179317` passed every gate, artifact build and Worker
  deployment. Its first resumed attempt hit one five-second Catalog test
  timeout; the focused test and failed-job rerun passed without changing code,
  timeouts or assertions.
- All six installed plugin bundles match the compiled OpenCode 2.0.19 regression
  image tested before rollout.

### Live evidence

- API edge and Durable Object, executor, Admin, Discovery and Mac transport
  report the exact merged revision and ready status. The Mac passed both local
  and public-tunnel probes after its attested artifact installation. Both
  automatic deployment LaunchAgents were restored.
- Admin generated the operator-approved anime identity sheet through Codex's
  durable image queue. The completed sheet was visually inspected.
- The application's R2 bucket has its managed public domain disabled and no
  custom domains.
- OpenCode retained all 15 exported sessions, their permissions and history.
  Its 89 active plugins match the pre-cutover inventory; native agent and
  instruction loaders remain active. A ticketed PTY shell roundtrip passed.
- The deployed `opencode-go/deepseek-v4.1-flash` persona called `take_photo` once.
  The completed tool result contained the actual JPEG. A subsequent model turn
  reviewed its visible setting and appearance before calling `send_photo`.
- iMessage reported one delivered attachment-only photo with no caption.
  The generated image and authenticated Admin preview were byte-identical:
  464,172 bytes, 1152×1536 JPEG, SHA256
  `402003c6cc37dfb98451eb9de2d1f4aa7966602a15f9ddbd2352ea08476b3912`.
  The delivered image was visually inspected.
- Admin preview returned HTTP 200 with `Cache-Control: no-store` when
  authenticated, and HTTP 401 without authentication.
- Rebuilding the test Conversation replayed the outgoing photo as actual image
  input with the same SHA256. The replacement session succeeded, its persisted
  binding became writable, and runtime inspection reported idle with zero
  pending inputs. Delivery remained exactly one image after replay.
- The delivered image and authenticated preview remained byte-identical after
  the final Mac artifact restart, with exactly one image in transport history.

Private transcripts, recipient identifiers, credentials and image bytes remain
outside the repository. The native idle-wait request returned HTTP 502 while the
persona was in its ordinary wait tool; persisted tool results and the delivered
transport record establish success. No generation or send retry was submitted.
The operator rebuild request ended with an error, but durable continuation
completed replay. The previous native session remained present with a read-only
binding; its export was preserved before rebuilding.

### Remaining verification

The broader model-behavior scenarios in [the specification](conversation-photos.md#verification),
including provider contention and uncertain-send fault injection, are not
claimed as live-verified by the successful take/send check above.
