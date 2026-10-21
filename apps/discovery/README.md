# Discovery

`renai.im` serves this Vite browser app and public profile HTML through a
Cloudflare Worker with static assets.
`/` is the public introduction home, with service details, the waitlist process,
FAQs and the same localized privacy notice used during registration. It does not
request the Catalog. Its calls to action open `/explore`, which contains image
style selection, profile browsing and waitlist registration. The Discovery logo
returns home; native links support browser history, reloads and direct entry.
Display language, image style and Likes retain their existing browser storage.
Private `/#reselect=…` links sent through iMessage still open Discovery directly
and retain their fragment for registration.

## Public profile links

`/personas/{id}` opens that persona in Discovery's existing expanded card. There
is no separate directory, menu or profile layout. The target is prioritized in
the normal deck; existing Likes and Passes are preserved, including a previous
choice for the shared persona. Collapse, Like/Pass, gallery browsing and contact
registration continue through the original UI. Registration includes the visitor's
current Likes. Only expanded profiles offer native sharing or URL copying through
a full-width action at the end of their content, above the floating Like/Pass
controls. Compact `/explore` cards and the reading toolbar have no sharing control.
Copy success/failure feedback appears inline below the share button.
Opening a profile updates the address; collapsing it returns to `/explore` while
preserving the deck, selected photo and private reselection fragment. Shared URLs
never contain that fragment, handles or browser choices.

The Worker reads api-app's current `/discovery/personas` response on each request,
including its retired-persona filtering. It validates and strips unknown fields,
renders public content into the initial HTML, and embeds only that public snapshot
for the browser so swiping can continue without another Catalog request. No private
persona description, State, Memory, identity sheet or authoring prompt is used.
HTML, sitemap and health responses use `Cache-Control: no-store`.

Home, explorer and profile requests all return the actual application UI in their
first HTML. Each profile has a distinct title, description and canonical URL,
Open Graph and Twitter metadata, and WebPage/CreativeWork JSON-LD that explicitly
identifies a fictional AI persona. Sharing carries `?style=anime` or `?style=photo`;
the preview uses that style's first gallery photo. The Worker verifies image bytes,
supported MIME type, dimensions and the 5 MB limit. Open Graph includes image URL,
secure URL, MIME type, width, height and descriptive alt text; Twitter includes
its own title, description, image and alt text. Portraits use a summary thumbnail
instead of a forced landscape crop. Missing, invalid or unreadable images use
the real 1200×630 `social.png` brand preview, with one correlated diagnostic for
read/decode failures. Its editable source is `design/social.html`.
Style variants share one canonical
URL for search indexing. Without an explicit style query, the server starts in
anime and the browser restores a saved preference. Public writing stays in its
authored language; controls support Korean, English and Japanese.

`/sitemap.xml` lists home, `/explore` and current public profile URLs with public
image locations. It never lists a separate directory or withdrawn personas.
`/robots.txt` advertises the sitemap. A missing, unpublished or retired profile
returns an actual 404 with `noindex`. Catalog or rendering failures return 503
with `Retry-After`, a request ID and payload-safe structured diagnostics.
`/health` identifies service `discovery`, embeds the artifact's source commit
(`development` locally), and reports Catalog readiness separately.

Both public profiles and waiting registration use `api.renai.im`:

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
Vite renders profile routes in the browser. To check the production HTML path,
build and run `bunx wrangler dev --port 3867 --var DISCOVERY_API_URL:http://127.0.0.1:4879`
from this directory with the Vite listener stopped.

## Deployment

Deploy through a PR merged into `main`, after the quality gates pass. CI builds
with `VITE_DISCOVERY_API_URL=https://api.renai.im` and the public
`TURNSTILE_SITE_KEY` repository variable, then deploys the static assets and checks
`https://renai.im/`, `/explore`, `/social.png`, `/sitemap.xml` and the exact artifact identity at
`/health`. api-app's deployment checks `/discovery/personas` separately.
Do not deploy manually or also connect Workers Builds.

`bun run build` builds browser assets. Wrangler bundles `worker/entry.ts` and
serves `dist/client/` assets. Home, explorer, public profile routes, sitemap,
robots and health run the Worker first; home remains independent of the live Catalog.
CI embeds `GITHUB_SHA` through Wrangler's `BUILD_REVISION` define.
`wrangler.jsonc` binds `renai.im` as a custom domain.
`www.renai.im` is a zone redirect. The api-app API permits `https://renai.im`
and verifies waiting registrations with the matching Turnstile secret.
Never put a private token in a `VITE_` key.

For a local packaging check, run `bun run build` and
`bunx wrangler deploy --dry-run` from this directory.
