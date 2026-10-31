---
status: accepted
---

# Social activity shares a Persona's life, not private relationships

RenAI's initial recruitment needs the Persona to discover relevant people and interact on X. The Operator chooses which Persona represents each account in Admin. X runs through agent-browser, CDP and a visible Chrome Canary on the Messages Mac.

## Decision

- Keep authoritative account connections, schedules, execution leases, usage and action receipts in a separate Cloudflare `SocialActivity` Durable Object. Social work never holds an iMessage turn or requires the messaging application to stay awake.
- Run the browser executor as a native macOS LaunchAgent in the logged-in GUI session. Existing OpenCode stays in its Docker deployment. CDP listens only on loopback; only the authenticated finite executor API crosses the Mac boundary.
- The existing Persona folder, State and Life memory are authoritative for social and iMessage activity alike. The first managed activity initializes that shared life once, whether it is social or an iMessage Conversation. This extends ADR-0023's first-Conversation initialization rule.
- Use separate OpenCode sessions and private memory scopes for public activity and each X contact. Scope keys include the account, assigned Persona, assignment generation and normalized contact handle. Public context has no DM or iMessage relationship history. A public discovery summary may enter the selected private context; private context never travels back to public or another contact.
- A social session has only the existing memory and dice tools. Its final structured decision is validated and executed by the host through fixed X browser actions. It receives neither a general shell nor model-authored JavaScript execution. The context plugin does not call the iMessage application for these sessions.
- The Operator creates dedicated X accounts and logs in manually. Persist browser profiles by Social account. Verify the logged-in X handle on navigation. Changing the assigned Persona or account handle fences old execution and uses a new session generation. The X account's own existing posts and messages remain on X.
- Record every action before browser I/O. Replays return an existing result; pending or uncertain writes are not submitted again. Check the current execution immediately before sending. Cancellation carries the old run ID so a delayed cancellation cannot stop a replacement run.
- Use existing invitations, without promising assignment to the inviting Persona. No automatic X-to-iMessage identity or memory linkage is introduced.

## Alternatives

- An independent marketing personality would diverge from the product's actual Persona and shared life.
- One social session holding every DM would expose private contacts to public writing and other contacts.
- A headless browser inside the executor container would miss the requested observable, manually logged-in Mac workflow.
- Granting OpenCode general browser-shell access would bypass account binding, scheduling, action receipts and send uncertainty.

## Consequences

The Mac needs agent-browser and Chrome Canary plus a logged-in desktop session. Platform DOM changes can interrupt a run; uncertain results remain visible for inspection rather than being retried blindly. Social account reassignment creates fresh private scopes, but does not rewrite X history. A social relationship is keyed by its X handle, not an inferred iMessage identity.
