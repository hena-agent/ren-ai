# A reset ends a test relationship and preserves its history

A test handle's `/reset` uses the [Relationship ending contract](../specs/persona-relationship-boundaries.md#테스트-주소의-reset): it permanently ends the current Conversation and sends a private Reselection link from `noti@renai.im`. The User, consent, registrations, Conversation and message history remain. Under [ADR-0023](0023-personas-share-one-life-across-up-to-five-conversations.md), the ended Relationship state and Relationship memory remain available for read-only review in the persona's folder, while her shared State, language proficiency and Life memory continue.

## Considered Options

- **Delete the User and start onboarding again.** Rejected: Reset is a relationship ending, and the User's consent, registrations and previous relationships must remain available.
- **Immediately start another Conversation.** Rejected: Reselection requires the private link, new Likes and consent, and Selection before the next Greeting.
- **Reset the persona's shared life.** Rejected: her other Conversations share that life and continue independently of this ending.
- **Allow everyone to reset.** Rejected because the service also serves real users. Only operator-marked test handles interpret the command.

## Consequences

- The command matches the entire message, ignoring case and surrounding whitespace. Editing another message into `/reset` does not execute it. A duplicate delivery does not reset twice.
- Command recognition uses a GUID's first observed text. imsg 0.15.9 supplies current text without edit provenance, so a never-observed message edited while the server is offline is indistinguishable from a command originally sent that way. Previously admitted messages are never reinterpreted as commands.
- Reset records the ending and command boundary atomically, fences ordinary actions and follow-ups, and schedules session interruption and Notification delivery. The ending survives interruption or delivery failures; uncertain sends are observed rather than blindly repeated.
- Reset creates neither a Greeting nor a new session. Reselection starts a new Conversation with another persona's current shared scope and a fresh Relationship scope. The ended persona is excluded for this handle only; her other relationships and public availability continue.
- Retained sessions stay in their persona's folder. Old browser tabs still open the old session, but cannot send or change State or Memory. Previous private relationship data and late message results never enter the new Conversation.
- Command GUIDs and receive boundaries survive restarts, so duplicate or late commands cannot end the next relationship. Test handles count toward the same five-current-Assignment limit as other handles.
- Rebuild is separate from Reset: it replaces an active Conversation's OpenCode session and preserves both scopes. Its source session and admitted-history boundary are durable, replay is read-only, and new input waits for the writable current session. Rebuild cannot reopen an ended relationship.
- Recovery input IDs use fixed-length hashes. Concatenating nested recovery IDs exceeded OpenCode's 100-character URL parameter limit and prevented reset from cancelling queued work.
