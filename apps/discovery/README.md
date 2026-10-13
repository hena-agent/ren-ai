# Discover on Cloudflare

`discovery.ambivalent.dev` serves this Vite browser app through the `discovery-ambivalent-dev`
Worker's static assets. `discovery.hena.dev` remains the separate selection and
iMessage onboarding site in `packages/discovery.hena.dev`.

## Local development

Run `bun run --cwd apps/discovery dev` from the repository root. The default
frontend is `http://127.0.0.1:3867`; its `/discovery/` proxy targets the standalone
API on port 4867. See `.env.example` for overrides.

## Automatic deployment

After the quality gates pass on `main`, the `Deploy discovery.ambivalent.dev` job in
[`ci.yml`](../../.github/workflows/ci.yml) builds with `VITE_DISCOVERY_API_URL=https://api-msg.hena.dev`
and `VITE_TURNSTILE_SITE_KEY` from the `TURNSTILE_SITE_KEY` repository variable (the existing
production widget), deploys the `discovery-ambivalent-dev` Worker in the `Ambivalent Co.` account,
and checks that the site answers. It uses the same `CLOUDFLARE_API_TOKEN_AMBIVALENT` secret as the
[Admin deployment](../admin/README.md#automatic-deployment). Do not also connect Workers Builds: it
would deploy every push a second time, without waiting for the gates.

Wrangler binds `discovery.ambivalent.dev` as a custom domain and serves `dist/` with
SPA navigation. Build variables are compiled into browser assets, not Worker runtime
variables. Never put a private token in a `VITE_` key.

Before the first production build:

1. Deploy the API change allowing `https://discovery.ambivalent.dev` on `/discovery/`
   while keeping the existing `https://discovery.hena.dev` origin.
2. Allow `discovery.ambivalent.dev` in the Invisible Turnstile widget. If using the
   existing widget, retain `discovery.hena.dev`; its API secret stays unchanged.
3. Publish personas in the Admin Catalog used by the API. See
   [Admin deployment](../admin/README.md).
4. Build and deploy, then verify HTTPS, style selection, public photos and
   waiting registration. The existing site's `/personas` and `/onboarding`
   remain separate.

For a local packaging check, run `bun run build` and
`bunx wrangler deploy --dry-run` from this directory.

## Initial frontend deployment and API handoff

The frontend was first deployed manually to `discovery.ambivalent.dev`; CI now
deploys it from `main`. To repeat a production build by hand from this directory:

```sh
VITE_DISCOVERY_API_URL=https://api-msg.hena.dev VITE_TURNSTILE_SITE_KEY=0x4AAAAAAFE4vOGM-bENVmad bun run build
bun run deploy
```

The API is being deployed separately. Until it is reachable, the frontend's
catalog error is expected. The API operator must:

- Serve `GET /discovery/personas` and `POST /discovery/waitlist` at
  `https://api-msg.hena.dev`. The updated `src/server.ts` composes the Discovery
  routes and first-contact reservations with the messaging server's persistent
  database. Deploy that updated application before enabling selection.
- Read published profiles from `https://admin.ambivalent.dev`. Configure the
  private Catalog token for the messaging runtime and retain the waitlist in
  persistent storage.
- Permit `https://discovery.ambivalent.dev` in CORS, including JSON POST
  preflight. The existing `discovery.hena.dev` onboarding origin stays active.
- Add `discovery.ambivalent.dev` to the existing Turnstile widget's allowed
  hostnames and use that widget's matching secret for API verification. The
  site's current key came from the existing site's GitHub repository variable;
  a different widget requires rebuilding with its site key.
- Publish personas in the new Admin Catalog and verify profile/image retrieval
  and waiting registration through the deployed frontend.
