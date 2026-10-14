# Discover on Cloudflare

`discovery.ambivalent.dev` serves this Vite browser app through the
`discovery-ambivalent-dev` Worker's static assets and same-origin
`GET /api/personas`. That endpoint reads the Admin Catalog D1 directly through
`@ren-ai/personas/catalog`; it does not call the messaging API or Admin HTTP API.
Only published profiles are returned, and image URLs point at Admin's
publication-checked image endpoint. `discovery.hena.dev` remains the separate
selection and iMessage onboarding site in `packages/discovery.hena.dev`.

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
`Deploy discovery.ambivalent.dev` job in
[`ci.yml`](../../.github/workflows/ci.yml) builds with
`VITE_DISCOVERY_API_URL=https://api-msg.hena.dev` and `VITE_TURNSTILE_SITE_KEY`
from the `TURNSTILE_SITE_KEY` repository variable, then deploys the
`discovery-ambivalent-dev` Worker in the `Ambivalent Co.` account. It uses the
same `CLOUDFLARE_API_TOKEN_AMBIVALENT` secret as
[Admin deployment](../admin/README.md#automatic-deployment).
Do not deploy manually or also connect Workers Builds.

`bun run build` builds both browser assets and the Worker. Wrangler's custom
build compiles only the Worker, preserving the browser assets and their
production API/Turnstile values from the preceding CI build.

Wrangler binds `discovery.ambivalent.dev` as a custom domain, serves
`dist/client/` with SPA navigation, and routes `/api/personas` to
`dist/worker/entry.js`. The runtime D1 binding points at the same
`persona-catalog` as Admin. `PERSONA_CATALOG_URL` supplies the image origin.
The read-only Worker does not own schema migrations.
`VITE_DISCOVERY_API_URL` is used only for waiting registration. Build variables
are compiled into browser assets, not Worker runtime variables.
Never put a private token in a `VITE_` key.

Before the first production build:

1. Allow `https://discovery.ambivalent.dev` in the messaging API's `/discovery/`
   CORS configuration while retaining `https://discovery.hena.dev`.
2. Allow `discovery.ambivalent.dev` in the Invisible Turnstile widget. If using
   the existing widget, retain `discovery.hena.dev`; its API secret stays unchanged.
3. Publish personas in the Admin Catalog bound to this Worker. See
   [Admin deployment](../admin/README.md).
4. Merge the PR and verify HTTPS, style selection, public photos and waiting
   registration after CI deploys. The existing site's `/personas` and
   `/onboarding` remain separate.

For a local packaging check, run `bun run build` and
`bunx wrangler deploy --dry-run` from this directory.

## API handoff

The messaging API is deployed separately. Its availability does not block
profile browsing; waiting registration still requires it. The API operator must:

- Serve `POST /discovery/waitlist` at `https://api-msg.hena.dev`. The
  `src/server.ts` composition uses the messaging server's persistent database
  for Discovery registrations and first-contact reservations.
- Read published profiles from `https://admin.ambivalent.dev` to validate Likes.
  Configure the private Catalog token for the messaging runtime and retain the
  waitlist in persistent storage.
- Permit `https://discovery.ambivalent.dev` in CORS, including JSON POST
  preflight. The existing `discovery.hena.dev` onboarding origin stays active.
- Add `discovery.ambivalent.dev` to the existing Turnstile widget's allowed
  hostnames and use that widget's matching secret for API verification.
- Publish personas in the Admin Catalog and verify profile/image retrieval and
  waiting registration through the deployed frontend.

Workers Observability is enabled. Catalog responses expose `X-Request-ID`; the
Worker logs operation, outcome and duration with that ID. Catalog failures are
503 errors rather than empty lists. Private Persona text, State, Memory and
database-error payloads are excluded from responses and logs.
