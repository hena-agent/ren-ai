---
status: accepted
---

# Notifications come from noti@renai.im

Service-authored Notifications use `noti@renai.im`, while Personas keep using
`hi@renai.im`. Both handles belong to the same Apple Account and share one Rustpush
bridge. This separates the service's voice from Conversations without operating a
second account; it does not isolate either handle from account-level restrictions.

Notifications have their own authenticated send/status RPCs and durable outgoing
history. A sender option on the existing `sendText` RPC was rejected because an
older Mac silently ignores unknown fields and would send from the Persona handle.
Notification replies are discarded, and Notifications never enter Persona history,
Memory, State, gestures or intake. Missing Notification registration does not stop
Persona messaging.

This revises ADR-0015's decision to send nothing when joining the Waitlist and adds
the Notification handle to ADR-0016/0018. Joining will attempt one informational
Notification, asynchronously, in the display/consent language; it neither verifies
the number nor starts a Conversation. Delivery failures do not affect Selection.
The existing Reselection message moves in a later change; the new-Conversation
marker remains inside the Persona's first bubble as an explicit exception.

Deploy the Mac capability first, then provision and verify the alias on a real
test handle before enabling Discovery sends. The agreed two-step scope and copy
are recorded in [the Notification spec](../specs/notifications.md).
