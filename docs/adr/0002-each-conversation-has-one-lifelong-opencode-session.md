# Each conversation has one lifelong OpenCode session; iMessage is the record

The conversation as it exists in iMessage, read through imsg, is the record. The persona's OpenCode session is only her memory of it, and can be rebuilt at any time by replaying the conversation from onboarding. Each conversation gets one session for its whole life. Every message or tapback from the user becomes one prompt whose ID is derived from its iMessage GUID, so delivering it twice is harmless. OpenCode's own mid-turn delivery, per-session ordering, prompt caching, compaction and restart recovery do the rest.

## Considered Options

- **A fresh session each time the persona looks at her phone**, fed a view the server renders from iMessage plus a summary the server maintains. Rejected: it rebuilds the summaries, caching and ordering OpenCode already provides, and OpenCode would still resume those short sessions after a restart, so they would need fencing off.
- **A new session every day**, carrying a summary forward. Rejected: rotation rules for no gain over compaction.

## Consequences

- OpenCode resumes an interrupted turn by asking the model again, not by replaying its tool call, and an imsg send can't be made safe to repeat. So each send is recorded before it goes out. A send whose outcome is unknown holds back the conversation's next send until iMessage shows whether it went out. If it did, the waiting send is dropped and the persona is told.
- Anything from the service handle that appears in the conversation without the persona sending it is shown to her as her own message, so her memory never disagrees with the record.
- Compaction is her memory. Our compaction hook writes the summary from the persona's own instructions, because OpenCode's built-in summary prompt is written for resuming coding work.
