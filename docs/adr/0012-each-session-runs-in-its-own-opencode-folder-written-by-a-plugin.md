---
status: accepted
---

# Each session runs in its own OpenCode folder, written by a plugin from the catalog

Users now choose among several personas, and the operator wants each persona session to be inspectable as plain OpenCode: one folder per session, holding the persona as `.opencode/agents/<persona-id>.md` and the ground rules as `AGENTS.md`. The catalog stays the source of truth; folder files are rendered from it, and the persona plugin builds no agents itself. This revises ADR-0004's "OpenCode never parses the persona repo" and extends ADR-0010's persona location.

## Decision

- The application starts a conversation through the session-folder plugin's OpenCode RPC. The plugin writes `/srv/ren-ai/sessions/<session-id>/` (a writable volume; the plugin code and `opencode.json` stay read-only), then creates the session there through OpenCode's public API. The application allocates the session ID first. Keeping provisioning and creation together lets the plugin clean up a failed creation without guessing whether a disconnected HTTP request created a session.
- One folder per OpenCode session, not per conversation. A reset's retained session keeps its folder; a folder is deleted exactly when its session is.
- The agent file carries only OpenCode keys (description, primary mode, deny-all except `send`, `read`, `react`, `wait`) and the persona prompt. The catalog owns the other fields, because OpenCode 2.0.19 reads any unknown frontmatter key as a V1 agent. Runtime metadata is copied into `persona.json` beside the instructions so retained sessions keep their original time zone and memory guidance; public profile fields stay in the catalog.
- The ground rules are one template in this repo. The application rewrites agent files and `AGENTS.md` into every active session's folder when it starts and when the catalog changes; OpenCode applies the update mid-session. Retained sessions are never rewritten, so they show what the persona ran under.
- Catalog publication and conversation-binding changes are serialized: an edit cannot race past a reset or miss a newly admitted conversation. Active-folder updates require a live session and share the plugin's deletion lock, so a stale update cannot recreate a deleted folder.
- The location re-enables OpenCode's `AGENTS.md` loader, and the `context` hook keeps the agent prompt and `AGENTS.md` while still stripping OpenCode's own environment and tool guidance. The deny-all is still set per session at creation.
- The plugin is split into separate workspace packages under `packages/plugins` (tools, context, memory, title, session-folder, plus a shared application client), each its own OpenCode plugin.

## Considered Options

- **Mount the volume writable in the application.** Rejected: ADR-0010 keeps the services on network APIs only, and OpenCode's API cannot write files.
- **One folder per conversation.** Rejected: rebuild and reset give a conversation new sessions, and a retained session should keep the files it ran with.
- **Snapshot files at session start, never rewritten.** Rejected: catalog edits must reach ongoing conversations.
- **Folder files as the source of truth.** Rejected: the admin app and onboarding need the catalog's extra fields, and editing N copies invites drift.

## Consequences

- Existing active and retained sessions are moved into their own folders during a paused cutover.
- A conversation's persona is fixed at onboarding; test handles change it only by `/reset` and onboarding again.
