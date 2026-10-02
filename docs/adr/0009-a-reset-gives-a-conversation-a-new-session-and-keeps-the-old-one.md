# A reset returns a test handle to onboarding and keeps the old session for review

A test handle can text `/reset` to return to before onboarding. The old OpenCode session is interrupted and retained for review, and the active user and conversation are removed. Submitting the handle at msg.hena.dev again records fresh consent and sends a new notice and greeting in a new session. This revises the original memory-only reset decision: retaining admission status prevented operators from testing onboarding from the beginning. The physical iMessage thread stays the same; rebuilding never restores memory from before the latest reset.

## Considered Options

- **Start a new conversation for the same user.** Rejected because a conversation means the iMessage thread, and onboarding and removal assume one per user.
- **Delete the old session, as rebuild does.** Rejected because development needs both sessions available for comparison.
- **Immediately greet again and retain onboarding status.** Replaced because it makes website onboarding silently return success without sending anything.
- **Allow everyone to reset.** Rejected because the development server also serves real users. Only operator-marked test handles interpret the command.

## Consequences

- The command matches the entire message, ignoring case and surrounding whitespace. Editing another message into `/reset` does not execute it. A duplicate delivery does not reset twice.
- Command recognition uses a GUID's first observed text. imsg 0.15.9 supplies current text without edit provenance, so a never-observed message edited while the server is offline is indistinguishable from a command originally sent that way. Previously admitted messages are never reinterpreted as commands.
- Each fresh session is a separate entry in the Web UI. Retained sessions are renamed `Persona1 · HANDLE · reset 2026-09-29 Tue 14:03`, using the persona's time zone; the current session keeps its usual title. Existing browser tabs remain on the session they show.
- Reset commands, old edits, unsends and tapbacks on old messages never enter the new memory. A new reply quoting an old message still carries its quote.
- Reset sends no greeting and creates no empty session. Onboarding waits for session retention to finish; it then starts afresh, including consent, join date and admission status. Follow-ups stop until the user replies to the new greeting. Unconfirmed old sends cannot block that greeting or leak into new memory.
- Reset GUIDs and the notice audit survive removal of the active user. Each reset records the last prior notice ID so old delivery records cannot suppress fresh onboarding, even when timestamps are equal. Duplicate commands cannot remove a newly onboarded user.
- Recovery input IDs use fixed-length hashes. Concatenating nested recovery IDs exceeded OpenCode's 100-character URL parameter limit and prevented reset from cancelling queued work.
- Test-handle marks persist across removal. Removing a test handle preserves all its sessions, renaming the current one with `· removed …`. Unmarking it and removing it deletes all its sessions, including retained ones. Rebuild still deletes the current session it replaces.
