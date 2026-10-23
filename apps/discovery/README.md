# Discovery

`renai.im` serves this Vite browser app and public profile HTML through a
Cloudflare Worker with static assets.
`/` is the public introduction home, with service details, the waitlist process,
FAQs and the same localized privacy notice used during registration. It does not
request the Catalog. Its calls to action open `/explore`, which contains image
style selection, profile browsing and waitlist registration. `/explore` returns its
header and loading state without requesting or waiting for the Catalog. After the
browser application starts, its existing client fetches `/discovery/personas` once
and displays the cards. A failed listing offers an inline retry; an unavailable API
does not prevent the initial HTML response. No empty Catalog bootstrap is embedded.
The Discovery logo returns home; native links support browser history, reloads
and direct entry.
Display language, image style and Likes retain their existing browser storage.
Private `/#reselect=…` links sent through iMessage still open Discovery directly
and retain their fragment for registration. The browser also sends the token to
the private Reselection listing, which hides personas who ended a relationship
with that handle only. Public listings remain independent of relationship endings.

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

For public profile requests, the Worker reads api-app's current
`/discovery/personas` response before rendering the profile.
Published personas remain listed at their five-assignment capacity, without a
capacity badge. Selection enforces capacity; Discovery makes no exclusivity promise
and has no exclusivity section or its images. The Worker validates and strips unknown
fields, renders public content into the initial HTML, and embeds only that public snapshot
for the browser so swiping can continue without another Catalog request. No private
persona description, State, Memory, identity sheet or authoring prompt is used.
HTML, sitemap and health responses use `Cache-Control: no-store`.

Home, explorer and profile requests all return the actual application UI in their
first HTML: home has its editorial content, explorer has its loading state, and
profile links have their full public profile. Each profile has a distinct title,
description and canonical URL,
Open Graph and Twitter metadata, and WebPage/CreativeWork JSON-LD that explicitly
identifies a fictional AI persona. Sharing carries the selected `style` and a
`preview=v2` rendition version, so new shares have a fresh identity after the OG
format changes. Open Graph and Twitter advertise a same-origin 1200×630 JPEG at
`/personas/{id}/og/{style}/{photo-id}.v2.jpg`. Its source is the first published
same-style gallery photo: the Worker reads its owned object key directly from
R2, then uses the Images binding to draw a blurred/dimmed backdrop, the uncropped
portrait and a small Ren AI watermark in the lower-right corner. Watermark source
is `design/og-watermark.html`; the transparent PNG is `public/og-watermark-v2.png`.
The cherry-rose brand symbol and white wordmark have no surrounding background box.
Bump the rendition version when changing its composition or watermark.

HTML metadata generation does not fetch image bytes. This removes the original
Workers-only failure: `redirect: "error"` was accepted in Node tests but throws
before an outbound Workers request. A renderer failure returns a correlated,
retryable 503; it never silently replaces a published persona preview with brand
artwork. Home/explorer and genuinely absent same-style photos use `social.png`.
Open Graph includes image MIME type, width, height, secure URL and alt text;
Twitter uses the large-image card and explicit image/title/description/alt fields.
Style variants share one canonical
URL for search indexing. Without an explicit style query, the server starts in
anime and the browser restores a saved preference. Public writing stays in its
authored language; controls support Korean, English and Japanese.

`/sitemap.xml` lists home, `/explore` and current public profile URLs with public
image locations. It never lists a separate directory or withdrawn personas.
`/robots.txt` advertises the sitemap. A missing or unpublished profile
returns an actual 404 with `noindex`. Catalog-dependent routes or rendering failures
return 503 with `Retry-After`, a request ID and payload-safe structured diagnostics.
`/health` identifies service `discovery`, embeds the artifact's source commit
(`development` locally), and reports Catalog and preview-executor readiness
separately. The preview probe checks R2 access and free Images metadata parsing.
Each image request revalidates publication and current gallery order before
consulting the rendition cache. Stale/unpublished image URLs return 404 even if
the old rendition was cached. Only derived renditions are cached; image responses
remain `no-store` so public CDN caching cannot bypass that validation.

Browser listings, server-rendered public profiles and waiting registration use `api.renai.im`:

```text
Discovery → api-app /discovery/personas → Admin public Catalog → D1
Discovery → api-app /discovery/waitlist → application Durable Object
```

api-app serves the public Catalog through its existing snapshot cache, invalidated
by Catalog changes. Server-rendered profiles request it with `cache: no-store`;
explorer uses the existing browser client, so later visits see profiles without a
frontend rebuild. The public snapshot retains the original R2 image URLs. Private persona
descriptions, State and Memory never enter the public response.

## Browsing images

Browsing loads original photos directly from `persona-images.renai.im`, without a
Discovery image proxy or request-time resizing/re-encoding. The current card and
expanded profile have high fetch priority. The next card loads at low priority;
Like thumbnails are lazy-loaded. Style preparation decodes the same original URLs.

New R2 photos have `Cache-Control: public, max-age=31536000, immutable`. Cloudflare
can cache JPG, PNG and WebP through the R2 custom domain without an additional Cache
Rule. Browser cache metadata alone does not prove edge caching: verify the original
URL with repeated GET requests and inspect `CF-Cache-Status` and `Age`. The latest
production check on 2026-10-23 returned `HIT` on all three GET requests.

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
Packaged preview images additionally need the `PORTRAITS` R2 and
`IMAGE_TRANSFORMS` bindings. High-fidelity overlay checks use an isolated remote
Wrangler preview, not a production deployment.

## Deployment

Deploy through a PR merged into `main`, after the quality gates pass. CI builds
with `VITE_DISCOVERY_API_URL=https://api.renai.im` and the public
`TURNSTILE_SITE_KEY` repository variable, then deploys the static assets and checks
`https://renai.im/`, `/explore`, `/social.png`, `/sitemap.xml` and the exact artifact identity at
`/health`. api-app's deployment checks `/discovery/personas` separately.
`check:preview` then reads a published profile in each available style and fetches
the exact advertised image, requiring a public JPEG, 1200×630 dimensions and less
than 5 MB. It rejects the former brand-image substitution; empty public Catalogs
are reported explicitly. The Worker accepts source photos up to the Images
binding's 20 MB input limit and returns bounded, fixed-size JPEG renditions.
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
