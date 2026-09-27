# The persona reads a tagged, language-neutral transcript; only its last line changes between requests

Each message from the user reaches the persona as its own prompt in English tags, stamped with when it was sent in the persona's time zone: `<message at="2026-09-25 Fri 20:52">나 방금 퇴근했어</message>`. The user's words go in as written, and the server holds no text in any one language, so every word of Korean comes from the persona or the user. The two facts that change between requests, the current time and whether the user has read her last message, go in one line our `context` hook adds after everything else and never stores (`<phone now="…" your-last-message="read 21:04"/>`). The system prompt and the stored history stay identical from one request to the next, so the provider's prompt cache holds for the whole conversation.

## Considered Options

- **A chat log in the persona's language** (`[9월 25일 (금) 오후 8:52] 나 방금 퇴근했어`, `(반응) 😂`). Closer to what her phone shows, but every label and the reading guide would need a table per language. Rejected for that cost.
- **The current time in the system prompt.** Rejected: it changes on every request, and a change at the top of the prompt voids the cache for everything after it.
- **Facts from onboarding, such as the user's name, filled into the persona's prompt.** Rejected: onboarding asks only for a handle, and she learns his name in conversation, as a person would. Her memory keeps it.

## Consequences

- The system prompt says nothing about the user, so it's the same for every conversation with a persona.
- Stored prompts keep their format for the session's life. Changing the format later means rebuilding sessions from the record, or a memory written in two formats.
- The persona supplies its time zone, the line that opens a conversation, and the instructions for its memory summary.
