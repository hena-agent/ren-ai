# Persona sessions in OpenCode

Open <https://oc.hena.dev> and sign in with the existing OpenCode credentials. Each persona session lives in its own `/srv/ren-ai/sessions/<folder-id>` location; search by the User's Handle to find a Conversation. The root `/srv/ren-ai` is the read-only plugin/config location, not a shared session working folder.

The native OpenCode interface is fully interactive. Prompts and controls act on the live session, and iMessages are sent through its conversation-bound `send`, `read`, `react`, and `wait` tools. The custom read-only viewer has been removed.

After `/reset`, a test handle can onboard again at discovery.hena.dev to get a new session. Earlier sessions retain their Memory and carry `· reset TIME` or `· removed TIME` in their titles. Opening an old browser tab still opens that old session; only the current active binding can send to the Conversation.

Inspect `.opencode/agents/<persona-id>.md` for the persona agent, `AGENTS.md` for ground rules, `persona.json` for its catalog snapshot, and `opencode.json` for its default agent and disabled built-ins. Active folders refresh from the external catalog at application startup and catalog change; retained sessions keep their historical files. Editing generated files is not a catalog update.

Deployment, paused folder migration, and independent host replacement are described in the [operations runbook](../../packages/api-msg.hena.dev/ops/README.md). See [ADR-0010](../adr/0010-separate-the-messages-mac-from-opencode.md) for service ownership/authentication and [ADR-0012](../adr/0012-each-session-runs-in-its-own-opencode-folder-written-by-a-plugin.md) for native session folders.
