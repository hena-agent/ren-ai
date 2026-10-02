# Persona sessions in OpenCode

Open <https://oc.hena.dev> and sign in with the existing OpenCode credentials. Persona sessions live in the `/srv/ren-ai` location; search by the User's Handle to find a Conversation.

The native OpenCode interface is fully interactive. Prompts and controls act on the live session, and iMessages are sent through its conversation-bound `send`, `read`, `react`, and `wait` tools. The custom read-only viewer has been removed.

After `/reset`, a test handle can onboard again at discovery.hena.dev to get a new session. Earlier sessions retain their Memory and carry `· reset TIME` or `· removed TIME` in their titles. Opening an old browser tab still opens that old session; only the current active binding can send to the Conversation.

Deployment, migration, and independent host replacement are described in the [operations runbook](../../packages/api-msg.hena.dev/ops/README.md). See [ADR-0010](../adr/0010-separate-the-messages-mac-from-opencode.md) for service ownership and authentication.
