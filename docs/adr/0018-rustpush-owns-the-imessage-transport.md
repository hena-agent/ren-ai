---
status: accepted
---

# Rustpush owns the iMessage transport

Replace the native imsg executable and Messages UI automation with a supervised,
long-running Rustpush bridge behind the existing authenticated `@ren-ai/imsg` API.
Native IDS/APNs operations give explicit service-handle selection for first contact
and gestures without foreground UI state. Every Persona uses `hi@renai.im`; this
does not introduce per-Persona handles or change Conversation identity.

This supersedes ADR-0005's UI transport choice and revises ADR-0010's Mac transport
and permission-provisioning requirements. The Mac still owns messaging and image
conversion, independently of the application and OpenCode.

The gateway owns durable SQLite history and records outgoing texts before native
submission. Uncertain outcomes remain pending and are never retried automatically.
The bridge persists raw notifications before APNs acknowledgement and retains them
until the gateway confirms storage and delivery certification succeeds. GUID
deduplication makes replay safe for the gateway's history.

The native bridge and gateway deploy as one artifact; the network contract remains
compatible with independently deployed clients. Apple credentials and private
message state stay on the Mac. Production cutover is a separate attended operation,
requiring historical reconciliation, pause-period catch-up and rollback verification.

## Send recovery (2026-10-20)

Application-owned text attempts carry a durable UUID through `submitText`; the
gateway records that exact GUID before native submission. Admission and detaching
submission from the HTTP caller are uninterruptible. Repeated submissions return
the existing identity without sending again; reusing an admitted identity with
different content or a different Handle is rejected.

`resolveSend` observes an admitted UUID or atomically fences an absent one. Fences
live in the gateway's SQLite file, survive restart, and do not create fictional
message-history rows. A fenced UUID can never be submitted later. Accepted but
unconfirmed native sends remain pending and can settle through receipts.

The application stores `attempt_id` separately from observed legacy GUIDs: absence
of a legacy row cannot be converted into transport proof. The operator's scoped
`release-send HANDLE CALL_ID` reconciles first. For a legacy attempt only, invoking
it explicitly attests that the old submission can no longer execute and the
operator has verified non-delivery. It records failure without resending, deleting
history or replacing the Conversation. Identified pending attempts cannot be
force-released. This also permits attended recovery of legacy uncertain gestures.

Deploy and verify the Mac gateway first, then the application. Separate RPC tags
ensure an older Mac cannot silently ignore the application-owned identity. The
existing `sendText` RPC remains available for independently deployed clients; the
new application never falls back to it for an identified attempt.
