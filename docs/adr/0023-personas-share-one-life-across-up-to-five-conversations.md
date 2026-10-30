---
status: accepted
---

# Personas share one life across up to five Conversations

[ADR-0013](0013-conversations-own-state-and-two-tier-memory.md) gave each Conversation its own State and Memory and left a shared Persona life to an explicit redesign; this is that redesign. A persona can now hold up to five current Assignments, and her condition and her own life are shared by all of them, while each relationship stays private to its user. This supersedes ADR-0013, replaces ADR-0012's one-folder-per-session layout, reverses ADR-0017's per-Conversation proficiency, and revises rebuild and reset in ADR-0002 and ADR-0009.

## Decision

- **Two scopes.** State (mood, energy, stress, connection, solitude, traits, language proficiency and her own additional values) and Life memory belong to the persona and are shared by all her Conversations. Relationship state (affection and additional values about one user) and Relationship memory belong to one Conversation, as does the starting relationship. Both memory scopes keep short-term and long-term Markdown documents.
- **Isolation by tools.** A session reads and writes the shared scope and its own Relationship scope; context, search and tools never expose another Conversation's. Shared documents never identify a user, hold private details or describe her other relationships, and the reasons recorded with shared changes are written so that any of her Conversations may read them.
- **One OpenCode folder per persona.** `/srv/ren-ai/personas/<persona-id>/` holds the agent, ground rules, `persona.json`, the shared scope and one `conversations/<conversation-key>/` Relationship scope per Conversation, keyed by its never-reused Conversation key. Every session of that persona opens there, including retained and ended ones, and a Catalog change rewrites one folder per persona. Deleting a session deletes neither scope; a Relationship scope is removed only with its Conversation's data. Operator-created sessions and forks move to Sandboxes that run on copies.
- **Parallel turns, optimistic shared writes.** A persona's sessions run concurrently. A write to a shared item (one State field, the short-term Life memory document or one long-term record) is rejected when another Conversation changed that item after the model last saw it; the rejection returns the current value and the change, and the persona decides again. One lock per persona folder covers every writer, and replay receipts are keyed by session and tool call.
- **Provenance in every context.** Each shared item shows when it last changed, whether in this Conversation or another, and the recorded reason. Short-term Life memory also shows a bounded summary of what changed since the session last saw it. The ground rules tell her that changes she did not make here come from her own life or other Conversations, are not errors, and are not the current user's doing.
- **Assignments.** A handle has at most one current Assignment and a persona at most five, counting pending and uncertain first contacts and test handles, checked in the reservation transaction. A Relationship ending excludes the persona for that handle only, in Selection, test starts and the Reselection listing; retired personas no longer exist. Discovery keeps showing personas at capacity.
- **Lifecycle.** A persona's folder is created at her first Conversation from the Catalog's initial State and Memory; later edits to those initial values change only new Conversations' starting affection. A rebuild keeps both scopes and rejects State and Memory writes until its replay finishes. A test handle's Reset permanently ends its current Conversation, preserving the User, consent, registrations and history and retaining its private Relationship scope for read-only review. The persona's single shared scope, including proficiency and Life memory, continues; the ended session cannot write either scope. Reset sends a private Reselection link from the Notification handle `noti@renai.im` and creates no new Conversation automatically. Reselection and Selection later start a Conversation with another persona's current shared scope and a fresh Relationship scope.
- **Disclosure.** Asked directly, she says she is a RenAI persona who also talks with other people. She never raises it herself, never uses other users for jealousy, comparison or her own story, and never reveals who they are or what they said.

## Considered Options

- **One fully shared State and Memory.** Rejected: users' names, facts and promises would mix, affection is by definition about one user, and only instructions would keep one user's private details from another.
- **Every session searching every Relationship scope.** Rejected for the same reason.
- **Serialising a persona's turns.** Rejected: a turn can stay open for up to 55 minutes in `wait`, blocking her other users.
- **Last-writer-wins, or mergeable deltas and itemised Memory.** Last-writer-wins silently loses concurrent changes. Mergeable operations would reshape every tool and document and make absolute judgments awkward. With at most five Conversations conflicts are rare, and a rejection is exactly when she should learn of the other change.
- **Sandboxed test handles.** Rejected: a test handle tries the service as a user would, including her shared life. Experiments that must leave her untouched run in operator Sandboxes.

## Consequences

- Existing data moves during a planned pause without exposing one user's memories to another. A persona's active Conversation contributes her mood, energy, stress, connection, solitude, traits and proficiency to State; its affection, additional values and both Memory tiers become its Relationship scope. Life memory starts from the Catalog's initial Memory, ended and retained sessions become retained Relationship scopes, and every session moves into its persona's folder.
- Retained and ended sessions see the current agent and ground rules instead of those they ran under; Persona versions keep the identity history.
- Discovery stops promising exclusivity.
- Proficiency growth in one Conversation is visible in all of them. Discovery still shows the operator-approved initial proficiency.
- Shared changes alter every session's system context; the prompt-cache cost is measured after rollout.
