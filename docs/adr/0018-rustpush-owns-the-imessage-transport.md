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
