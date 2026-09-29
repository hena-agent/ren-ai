# A reset gives a conversation a new session and keeps the old one for review

A test handle can text `/reset` to wipe the persona's memory of its conversation. The conversation stays the same iMessage thread with the same user and persona, but gets a new OpenCode session, a notice and a greeting. The old session is interrupted and retained for review in the Web UI. This changes ADR-0002: only one session is current, but a reset starts another, and subsequent rebuilds replay only from the latest reset.

## Considered Options

- **Start a new conversation for the same user.** Rejected because a conversation means the iMessage thread, and onboarding and removal assume one per user.
- **Delete the old session, as rebuild does.** Rejected because development needs both sessions available for comparison.
- **Allow everyone to reset.** Rejected because the development server also serves real users. Only operator-marked test handles interpret the command.

## Consequences

- The command matches the entire message, ignoring case and surrounding whitespace. Editing another message into `/reset` does not execute it. A duplicate delivery does not reset twice.
- Command recognition uses a GUID's first observed text. imsg 0.15.9 supplies current text without edit provenance, so a never-observed message edited while the server is offline is indistinguishable from a command originally sent that way. Previously admitted messages are never reinterpreted as commands.
- Each fresh session is a separate entry in the Web UI. Retained sessions are renamed `Persona1 · HANDLE · reset 2026-09-29 Tue 14:03`, using the persona's time zone; the current session keeps its usual title. Existing browser tabs remain on the session they show.
- Reset commands, old edits, unsends and tapbacks on old messages never enter the new memory. A new reply quoting an old message still carries its quote.
- Follow-ups stop until the user replies to the new greeting. Unconfirmed old sends cannot block the greeting or leak their content into the new memory. The user's consent, join date and admission status remain.
- Test-handle marks persist across removal. Removing a test handle preserves all its sessions, renaming the current one with `· removed …`. Unmarking it and removing it deletes all its sessions, including retained ones. Rebuild still deletes the current session it replaces.
