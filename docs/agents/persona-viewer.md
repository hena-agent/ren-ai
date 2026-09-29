# Viewing a Persona session in OpenCode V2

`https://chris-mini.pug-mohs.ts.net:8447/` serves the official V2 browser UI at the same origin as the Persona viewer's password-protected, GET-only API. The UI assets come from a separately isolated OpenCode 2.0.16 process on `127.0.0.1:47987`. See [the Mac mini runbook](../../packages/api-msg.hena.dev/ops/README.md) for its install and startup. Never expose 47987 through Tailscale or Funnel, use the Mac owner's OpenCode service, or run `opencode pair` on the Persona host.

1. Open `https://chris-mini.pug-mohs.ts.net:8447/`. At the browser's **Persona viewer** authentication prompt, enter username **opencode** and the `dev.hena.ren-ai.viewer` / `api-msg` password from Keychain. Authentication is required before the UI loads, so the browser can also authenticate same-origin event requests when the app omits an Authorization header. If the app then shows its connection form, enter `https://chris-mini.pug-mohs.ts.net:8447` as **Server address** and the same viewer password. Do not use the isolated asset process's password. The form checks `GET /api/info`; it sends no messages.
2. Obtain the session ID for the Conversation from the authenticated `GET /api/session` response (the array is under `data`). The operator can retrieve IDs and Persona names without putting a password in argv or printing message content:

   ```sh
   { printf 'header = "Authorization: Basic %s"\n' "$(printf 'opencode:%s' "$(/usr/bin/security find-generic-password -w -s dev.hena.ren-ai.viewer -a api-msg)" | base64 | tr -d '\n')"; } |
     curl --silent --show-error --fail --config - 'https://chris-mini.pug-mohs.ts.net:8447/api/session' |
     jq -r '.data[] | [.agent, .id] | @tsv'
   ```

3. Open `https://chris-mini.pug-mohs.ts.net:8447/server/aHR0cHM6Ly9jaHJpcy1taW5pLnB1Zy1tb2hzLnRzLm5ldDo4NDQ3/session/<session-id>` with the chosen ID. The encoded server segment is base64url of the viewer URL; it is not a credential. A fresh browser needs step 1 first.

The Extensions settings tab lists MCP names/statuses, plugin names and skill names from the server's default location. Failure details, plugin source paths, and skill files/content are hidden. Background provider, model, integration and VCS reads return only display metadata; provider keys, request headers, settings, URLs, command authentication and environment details are removed. Only the server's own default location can be read, whether the UI omits it or sends its exact directory. The official app still displays MCP switches, but this viewer is **read-only**: switching one on or off returns 403 and does not change the server. `/api/config`, worktree refresh, other project directories and all API mutations remain denied. `/api/config` can expose provider credentials; never allow it through unchanged. An empty home page is not evidence the session is missing; use its direct session URL. The viewer rejects sends even if the app shows a Send button.
