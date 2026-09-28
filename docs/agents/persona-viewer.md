# Viewing a Persona session in OpenCode V2

`https://chris-mini.pug-mohs.ts.net:8447/` is the Persona viewer. It serves the official OpenCode V2 browser UI **at the same origin** as its password-protected, GET-only API. The Persona host cannot itself serve the UI assets: they are embedded in the official CLI. Do not use `https://app.opencode.ai` (currently V1), `opencode pair`, or the Mac owner's OpenCode service and credentials.

Before deploying this viewer change, install an official OpenCode **2.0.16** CLI binary (matching the embedded host) from `https://opencode.ai/files/bin/2.0.16/opencode-darwin-arm64.zip`. Start its asset-serving process on **loopback only**, with its own private directories (replace paths below with persistent, operator-owned paths):

```sh
isolated=/path/to/persona-web-shell
mkdir -p "$isolated"/{home,config,data,cache,state}
env -i PATH=/usr/bin:/bin HOME="$isolated/home" \
  XDG_CONFIG_HOME="$isolated/config" XDG_DATA_HOME="$isolated/data" \
  XDG_CACHE_HOME="$isolated/cache" XDG_STATE_HOME="$isolated/state" \
  OPENCODE_CONFIG_DIR="$isolated/config" OPENCODE_CONFIG_PROJECT_DISABLE=1 \
  OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_PASSWORD="$(openssl rand -hex 32)" \
  /path/to/opencode-v2.0.16 serve --hostname 127.0.0.1 --port 47987
```

Supervise that process, then deploy the updated Persona viewer. **Do not expose port 47987 with Tailscale Serve or Funnel.** The viewer proxies only its static UI paths to that process; `/api/*` and `/openapi.json` never reach it. Its private password protects its otherwise unused, empty API. If it is down, the viewer returns 502 for the page while its Persona API remains independently available.

1. Open `https://chris-mini.pug-mohs.ts.net:8447/` for the V2 UI, then visit [`/connect`](https://chris-mini.pug-mohs.ts.net:8447/connect). Enter `https://chris-mini.pug-mohs.ts.net:8447` as **Server address** and the `dev.hena.ren-ai.viewer` / `api-msg` password from Keychain as **Password**. Do **not** enter the isolated CLI password. The form tests `GET /api/info`; it sends no messages.
2. After connecting, open [the existing Persona1 session](https://chris-mini.pug-mohs.ts.net:8447/server/aHR0cHM6Ly9jaHJpcy1taW5pLnB1Zy1tb2hzLnRzLm5ldDo4NDQ3/session/ses_f1738ab1affeOMCCYwOP7Bxddr). Its server segment is base64url of the viewer URL; the session ID comes from `GET /api/session` and may differ for another Conversation. A fresh browser needs step 1 first.

The UI may ask for `/api/config`, models, or worktree refresh in the background. These are intentionally denied, as are all API mutations. Do not enable `/api/config`: it can expose provider credentials. An empty home page is not evidence the session is missing; use the direct session link after connecting. The viewer rejects sends even if the app shows a Send button.
