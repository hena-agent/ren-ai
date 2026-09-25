# OpenCode runs inside the server, on a host we assemble, cut off from the Mac's own OpenCode

The api-msg server hosts OpenCode in its own process. It assembles the host from OpenCode's published modules, the way `@opencode/sdk` does internally, because the SDK keeps its web handler to itself and the operator needs to watch conversations live in OpenCode's web UI. From that one host the server gets a client for its own calls, a plugin store for the imsg plugin it builds from its own parts, and the web handler, which it serves on localhost behind a password and a read-only allowlist. The host reads nothing from the Mac's own OpenCode setup or from the directories above the persona repo, and all state, OpenCode's and ours, lives in one SQLite file.

## Considered Options

- **`@opencode/sdk` as published.** In-process, but it serves no port and doesn't expose its handler, so the web UI couldn't show live conversations. Patching it was ruled out.
- **A dedicated OpenCode server, driven as a client.** Live in the stock web UI, but the message path would span two processes. OpenCode 2.0.16 has no remote plugins, so the imsg plugin couldn't be built from the server's own parts, and the record of sends would be shared through SQLite. OpenCode upgrades would also follow whatever CLI is installed.
- **The OpenCode server already running on the Mac.** All of the above, plus the owner's global plugins on every persona session (one translates prompts and replies, another posts assistant text to Discord), and persona memory stored in the owner's personal database.
- **A viewer on a copy of the database.** Safe and simple, but not live.

## Consequences

- We depend on modules below the SDK's public surface (its routes, plugin store and restart recovery), so an OpenCode upgrade can break the host. The pinned version and the gates catch that before it ships. The server's Effect version follows OpenCode's.
- ADR-0001's deny-all is set on each session when it's created, where OpenCode gives it the last word over the agent and all config. The imsg tools register with code mode off, and the `context` hook drops any other tool that appears.
- The persona repo holds content only: one file per persona in our own format, which OpenCode never parses.
- Nothing typed in the web UI reaches a conversation.
