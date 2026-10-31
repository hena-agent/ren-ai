# Conversation photos: steps 1–3 verification

Verified on 2026-10-26 against baseline
`705c38fd7570e648f8db91b75855e37055282cc4` (`origin/main`).
Implementation: `588f256980a817b419a64b21cd23f4bb245288a6`.
Design contract: [PR #159](https://github.com/hena-agent/ren-ai/pull/159).

## Implemented

1. Shared `@ren-ai/image-generation` Codex client and Admin's Arena-to-Codex
   switch, preserving image prompts, confirmation, FIFO and seeding reservations.
2. Discovery image style persisted on registration and copied into each new
   Conversation. Existing records default to anime; request/response fields stay
   optional. CI deploys the API before Discovery.
3. Identified, attachment-only JPEG sends through the authenticated Mac gateway,
   private staging, durable send ledger and Rustpush MMCS upload. Attempt reuse
   cannot change the handle or bytes or resubmit an admitted send after restart.

Application Outbox photo actions, persona tools, generation limits, private R2
storage and Admin Conversation-photo previews belong to steps 4–5.

## Automated evidence

- Node 24.15.0 and the deployment-pinned Bun 1.4.2.
- 1,822 TypeScript tests across 387 files passed.
- All 339 measured source files reached 100% statements, branches, functions and
  lines; existing documented coverage exceptions retained.
- 51 native tests passed, along with native coverage, Clippy, formatting,
  complexity, file-size and gate self-checks.
- Repository formatting, type-aware lint, typechecking, development/production
  Knip, duplication, exception validation, Discovery build and `verify-gates`
  passed. `bun run ci` was run once; after failures were fixed, affected and
  remaining checks were run separately.
- The state-import fixture now supplies and verifies the new non-null image style;
  its old implicit null caused the initial import-test failure. Two artifact tests
  initially rejected local Bun 1.4.4 and passed with the required Bun 1.4.2.
- The exact-revision Mac artifact built successfully with the installed Bun,
  native architecture/dylib checks and dependency-graph validation.

## Live Mac evidence

The operator authorized one JPEG to their chosen test handle on this Mac Mini.
The image was Discovery's public RenAI branding card, converted to JPEG.

- Local and public health reported the implementation's full revision and ready
  Messages and Notifications dependencies before the send.
- GUID: `81E6D130-91B1-41BE-B3FA-6684E8F5A0C4`.
- First request: `f519a827-e41b-4cc7-ab24-d4e264fcf32a`.
- Apple delivery receipt: **delivered**. Exactly one attachment-only history row;
  fetching its opaque reference returned the original JPEG bytes.
- After a gateway restart, request `2928f78b-9ed1-401d-90b7-9b54100d3ca7` repeated
  the same attempt. The GUID, delivered status, history row and bytes survived.
- Correlated native logs proved **one initial submission and zero submissions
  for the retry**.
- The original `705c38f` binaries were restored byte-for-byte, the deploy agent
  resumed, and local/public health again reported the original full revision as
  ready. The original build could still resolve and read the delivered photo.

This was a temporary live transport verification, not a production rollout of
the complete Conversation-photo feature. No live provider generation was run.

## Standards review

No hard documented-standard violations. Two judgment-only findings were fixed:
the native and gateway JPEG limits now agree at 10,000,000 bytes, and the photo
test adapter rejects conflicting attempt reuse.

## Spec review

No implementation findings or scope creep within steps 1–3. The initially
pending live acceptance is satisfied by the evidence above.

Summary: Standards — 0 hard violations, 2 observations resolved; Spec — 0 findings.
