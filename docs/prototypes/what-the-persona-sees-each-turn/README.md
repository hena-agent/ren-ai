# Prototype: what the persona sees each turn

Throwaway. Answers the wayfinder ticket [What the persona sees each turn](https://github.com/hena-agent/ren-ai/issues/8): what exactly does the model receive on each request, so the persona sees what a real person would see?

Open `what-the-persona-sees.prototype.html` in a browser. It needs no server and no install.

- **Left column:** a scripted iMessage Conversation, the record.
- **Right column:** what OpenCode 2.0.16 would send to the model at the selected request: the system prompt, the tools, and every message, each marked as stored, added by the `context` hook, rewritten, or dropped.
- **Controls:** switch between two formats and toggle each candidate signal. The URL hash keeps the view, for example `#s=1&f=A&r=8`.

Everything that decides what the model sees lives in the `PersonaView` module at the top of the script, a pure function over the Conversation. The page around it is disposable.

Verdict: see the resolution comment on the ticket.
