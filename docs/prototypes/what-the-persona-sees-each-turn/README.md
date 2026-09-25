# Prototype: what the persona sees each turn

Throwaway. Answers the wayfinder ticket [What the persona sees each turn](https://github.com/hena-agent/ren-ai/issues/8): what exactly does the model receive on each request, so the persona sees what a real person would see?

Open `what-the-persona-sees.prototype.html` in a browser. It needs no server and no install.

- **Left column:** a scripted iMessage Conversation, the record.
- **Right column:** what OpenCode 2.0.16 would send to the model at the selected request: the system prompt, the tools, and every message, each marked as stored, added by the `context` hook, rewritten, or dropped.
- **Controls:** switch between two formats and toggle each candidate signal. The URL hash keeps the view, for example `#s=1&f=A&r=8`.

Everything that decides what the model sees lives in the `PersonaView` module at the top of the script, a pure function over the Conversation. The page around it is disposable.

## Verdict

Settled on the ticket and recorded as ADR-0003:

- **Format B:** tagged and language-neutral, with every message stamped in the persona's time zone.
- **One last line:** the `context` hook adds it to each request and never stores it. It carries the current time and whether he read her last message.
- **Signals:** every toggle in the prototype stays on, edits and unsends included.
- **No `{{user.name}}` placeholder.** The prototype shows one, but it was rejected: onboarding asks only for a handle, and she learns his name in conversation, so the system prompt says nothing about the user.
