# Discover on Cloudflare

`renai.im` serves this Vite browser app through the `persona-discovery` Worker's
static assets and same-origin `GET /api/personas`, in the `Ambivalent Co.` account
([ADR-0016](../../docs/adr/0016-the-service-lives-at-renai-im-in-one-cloudflare-account.md)).
That endpoint reads the Admin Catalog D1 directly through
`@ren-ai/personas/catalog`; it does not call the messaging API or Admin HTTP API.
Only published profiles are returned, and image URLs point at Admin's
publication-checked image endpoint.

## Local development

Run `bun run --cwd apps/discovery dev` from the repository root. The default
frontend is `http://127.0.0.1:3867`. Run `bun run --cwd apps/discovery dev:worker`
alongside it: this builds the app and starts the D1 catalog listener at
`http://127.0.0.1:4873`. Vite proxies `/api/personas` there. The Worker shares
Admin's local `.wrangler/state` and fixed preview database ID. Apply Admin's
local D1 schema and run local Admin on port 3729 for its photos.
The `/discovery/` registration proxy still targets the messaging API on port 4867. See `.env.example` for overrides (`DISCOVERY_WORKER_URL`,
`DISCOVERY_WORKER_PORT`, `DISCOVERY_PERSIST_PATH`, `PERSONA_CATALOG_URL`).
Tests bind port 0.

## Automatic deployment

Deploy through a PR merged into `main`, after the quality gates pass. The
`Deploy renai.im` job in [`ci.yml`](../../.github/workflows/ci.yml) builds with
`VITE_DISCOVERY_API_URL=https://api-app.renai.im` and `VITE_TURNSTILE_SITE_KEY`
from the `TURNSTILE_SITE_KEY` repository variable, then deploys and verifies the
`persona-discovery` Worker. It uses the same `CLOUDFLARE_API_TOKEN` secret as
[Admin deployment](../admin/README.md#automatic-deployment).
Do not deploy manually or also connect Workers Builds.
The deployment job checks both the page and `/api/personas` before succeeding.

`bun run build` builds both browser assets and the Worker. Wrangler's custom
build compiles only the Worker, preserving the browser assets and their
production API/Turnstile values from the preceding CI build.

Wrangler binds `renai.im` as a custom domain, serves `dist/client/` with SPA
navigation, and routes `/api/personas` to `dist/worker/entry.js`. `www.renai.im`
is a redirect rule in the `renai.im` zone, not part of this Worker. The runtime D1
binding points at the same `persona-catalog` as Admin. `PERSONA_CATALOG_URL`
supplies the image origin. The read-only Worker does not own schema migrations.
`VITE_DISCOVERY_API_URL` is used only for waiting registration. Build variables
are compiled into browser assets, not Worker runtime variables.
Never put a private token in a `VITE_` key.

For a local packaging check, run `bun run build` and
`bunx wrangler deploy --dry-run` from this directory.

## API handoff

The messaging API is deployed separately. Its availability does not block
profile browsing; waiting registration still requires it. The API must permit
`https://renai.im` in CORS, including JSON POST preflight, and verify
registrations with the secret of the Turnstile widget whose site key the build
uses. Changing the widget means rebuilding the site and redeploying the API with
its secret. The [application runbook](../api/ops/README.md#move-to-renaiim)
covers the cutover.

Workers Observability is enabled. Catalog responses expose `X-Request-ID`; the
Worker logs operation, outcome and duration with that ID. Catalog failures are
503 errors rather than empty lists. Private Persona text, State, Memory and
database-error payloads are excluded from responses and logs.
