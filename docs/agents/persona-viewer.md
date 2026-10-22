# Persona sessions in OpenCode

Open <https://oc.renai.im> and sign in with the existing OpenCode credentials. All active, retained and ended sessions of a persona open in `/srv/ren-ai/personas/<persona-id>/`; search by the User's Handle to find a Conversation. The root `/srv/ren-ai` is the read-only plugin/config location.

The native OpenCode interface is fully interactive. Prompts and controls act on the live session, and iMessages are sent through its conversation-bound `send`, `read`, `react`, and `wait` tools. The custom read-only viewer has been removed.

After `/reset`, a test handle registers again through Discovery and is started from Admin's waitlist to get a new session and Relationship scope. Earlier sessions retain their Relationship state and Relationship memory and carry `· reset TIME` or `· removed TIME` in their titles. Shared State and Life memory continue. Opening an old browser tab still opens that old session; only the current active binding can send to the Conversation.

Inspect `.opencode/agents/<persona-id>.md` for the persona agent, `AGENTS.md` for ground rules, `persona.json` for its catalog snapshot, and `opencode.json` for its default agent and disabled built-ins. Catalog and ground-rule updates refresh one root per persona, including the instructions seen by retained sessions. Persona versions preserve identity history. Editing generated files is not a Catalog update.

The root holds shared State and Life memory; `conversations/<conversation-key>/` holds each relationship's private documents. Tools expose only the shared scope and the calling session's own Relationship scope. Deleting or rebuilding an OpenCode session preserves both; replay cannot write State or Memory. A Relationship scope is removed only with its Conversation's data. Operator-created native sessions and forks run in separate Sandboxes on copies, while test-handle Conversations participate in the persona's shared life.

Deployment, paused folder cutover, and independent host replacement are described in the [operations runbook](../../apps/api/ops/README.md); the Mac side is in the [Messages Mac runbook](../../apps/imsg/ops/README.md). See [ADR-0010](../adr/0010-separate-the-messages-mac-from-opencode.md) for service ownership/authentication and [ADR-0023](../adr/0023-personas-share-one-life-across-up-to-five-conversations.md) for shared persona roots and scope ownership.
