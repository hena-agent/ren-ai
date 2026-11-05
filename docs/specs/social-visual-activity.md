# Social visual activity and durable diagnostics

## Approved direction

- RenAI Personas openly identify as AI. Their generated appearances and imagined
  scenes are creative self-expression, not evidence of a human body or real events.
- Make visual self-expression and original creative work central to social activity.
  Choose image creation probabilistically from the current context, not a daily
  image-production target. Use default weights of 75% self-images and 25% original
  artwork/design/imagined scenes without the Persona herself.
- Generate, inspect, approve/reject, and publish as separate decisions. A generated
  image is not automatically posted. Observe real responses when choosing future
  work; never invent engagement. Reuse a pending draft instead of repeatedly paying
  for another one.
- Record each failed operation and its stage so it can be debugged from Admin.
  Preserve request/action correlation, timing, source revision, safe error/cause
  codes, stack frames and conservative external-submission certainty.
- Do not commit, push, merge, deploy, invoke paid generation or publish externally
  during implementation without separate operator approval.

## Implementation boundaries

- Cloudflare's SocialActivity Durable Object owns choices, receipts, scoped drafts,
  the bounded FIFO, authorization accounting and diagnostics. Mac executors own
  authenticated browser I/O and keep uploading files alive through verification.
- Persist probability, both dice draws, kind, style and source scope before paid
  work. Repeated submissions and identical ideas reuse the existing decision.
  Interrupted paid calls must never be automatically repeated.
  The model supplies a self-image scene and a separate creative scene before the
  roll, so each selected kind uses a fitting direction rather than forcing an
  artwork request into a selfie prompt or vice versa.
- Image generation is off unless explicitly enabled per account in Admin. Every
  configured account allowance contributes to one aggregate
  cumulative paid-call ceiling across all social accounts; show aggregate spend and
  ceiling in Admin. The cumulative ceiling is an operational boundary, not a daily
  target. Persist the approved ceiling across account-setting changes and never lower
  it below paid calls already made. Consume it immediately before provider dispatch.
  All social accounts share
  one social-image FIFO; authoring and private Conversation image workflows remain
  independent.
- Reuse the existing image provider and same-style identity sheet for self-images.
  Original creative work must not depict the Persona herself or identifiable real
  people. Keep prompts and generated assets outside Persona files, public catalog
  responses and all logs. Private Conversation photos must never become social
  attachments. Drafts and previews are scoped to account, Persona and generation.
- Pass the actual image to the model before accepting its review. Only approved
  images may be attached. An uncertain publication cannot reuse the attachment.
- Require a new owned receipt with matching text and media, then verify the actual
  permalink before confirming publication. Never re-submit while seeking a receipt.
- Save browser progress before side effects. A known pre-submit failure can release
  its reservation; an attempted or unknown send stays uncertain and deduplicated.
  Preserve diagnostics across actor replacement, callback failure and interruption.
- Expose previews only through authenticated management/Admin routes. Keep source
  fields optional during the Worker/Admin/Mac rollout. Enable production image
  activity only after the expected artifact and image prerequisites are ready.

## Verification

Use focused tests with fake providers/storage and isolated real agent-browser
0.41.0/Chrome against loopback HTML fixtures. Verify persistence, concurrency,
ownership changes, retry deduplication, privacy, exact dice boundaries and file
lifetime. Inspect indexed query plans and idle storage writes. Run full CI and
OpenCode integration in GitHub Actions after an approved push; production identity,
generation and external publication are separate approval-dependent checks.
