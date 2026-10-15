# Discovery

`renai.im` serves this Vite browser app through Cloudflare static assets.
Both public profiles and waiting registration use `api-app.renai.im`:

```text
Discovery → api-app /discovery/personas → Admin public Catalog → D1
Discovery → api-app /discovery/waitlist → application Durable Object
```

api-app requests the current public Catalog on each read. Discovery requests it
with `cache: no-store`, so a later read sees newly published profiles without a
frontend rebuild. Images retain Admin's publication-checked URLs. Private persona
descriptions, State and Memory never enter the public response.

## Local development

The root `bun dev` starts Discovery's Vite server on `http://127.0.0.1:3867`,
api-app on port 4879, and Admin on port 3729. Discovery opens only one listener;
Vite proxies `/discovery/` requests to api-app. There is no separate Discovery
catalog server or D1 binding.

Run only the frontend with `bun run --cwd apps/discovery dev`. It still needs
api-app and Admin for profiles. See `.env.example` for `DISCOVERY_API_URL`,
`VITE_DISCOVERY_API_URL` and Turnstile settings. Export `PORT` to override the
frontend port. Vite development and preview use `strictPort: true`.

## Deployment

Deploy through a PR merged into `main`, after the quality gates pass. CI builds
with `VITE_DISCOVERY_API_URL=https://api-app.renai.im` and the public
`TURNSTILE_SITE_KEY` repository variable, then deploys the static assets and checks
`https://renai.im/`. api-app's deployment checks `/discovery/personas` separately.
Do not deploy manually or also connect Workers Builds.

`bun run build` builds browser assets only. `wrangler.jsonc` binds `renai.im`
as a custom domain and serves `dist/client/` with SPA navigation.
`www.renai.im` is a zone redirect. The api-app API permits `https://renai.im`
and verifies waiting registrations with the matching Turnstile secret.
Never put a private token in a `VITE_` key.

For a local packaging check, run `bun run build` and
`bunx wrangler deploy --dry-run` from this directory.
