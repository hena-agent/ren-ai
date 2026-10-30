# Discovery

`renai.im` serves this Vite browser app and public profile HTML through a
Cloudflare Worker with static assets.
English public pages use `/`, `/explore` and `/personas/{id}` directly. Korean and
Japanese pages add `/ko` and `/ja` prefixes. Explicit prefixes control initial
server HTML and browser display. Unprefixed pages respect the saved language
cookie, then `Accept-Language`: Korean/Japanese preferences temporarily redirect
to their prefixed counterpart; English or undetected languages render English
in place. These responses use `Vary: Accept-Language, Cookie` and
`Cache-Control: no-store`. `/en` page URLs permanently normalize to the matching
unprefixed URL and save English so the next request cannot bounce to another
language. Switching language replaces the URL in place and saves the preference
in browser storage and a host-only language cookie, preserving mounted forms,
browsing state, queries and private fragments. Navigation and profile sharing
retain that language. `/` is the stable `x-default` destination. The page paths
below use English URLs; asset, API, health, robots, sitemap and OG image routes
are independent of display language.
`/` is the public introduction home, with service details, the waitlist process,
FAQs and the same localized privacy notice used during registration. It does not
request the Catalog. The Worker handles root-language negotiation, then passes
the prerendered English home body through unchanged, copying the response before
adding locale and request headers because the asset binding's headers are immutable.
Its calls to action open
`/explore`, which contains image
style selection, profile browsing and waitlist registration. `/explore` opens
directly on its cards. The Worker requests `/discovery/personas?locale=…` in the
saved language or highest-quality supported `Accept-Language` preference, falling
back to English, renders those ten candidates and embeds
them with their locale and cursor. The browser continues from that page without
resampling; with five unseen cards left it requests the next cursor page. If a
saved display language differs from the sampled one, the browser replaces the page
with a sample in its own language. The Worker waits at most three seconds: a
failed, invalid or slow listing is logged and `/explore` returns its loading shell
without a snapshot, so the browser fetches the listing and offers an inline retry.
`HEAD /explore` never requests the Catalog.
The Discovery logo returns home; native links support browser history, reloads
and direct entry.
Display language, image style and Likes retain their existing browser storage.
Private `/#reselect=…` links sent through iMessage still open Discovery directly
and retain their fragment for registration. The browser also sends the token to
the private Reselection listing, which hides personas who ended a relationship
with that handle only. Public listings remain independent of relationship endings.
Fragments never reach the Worker, so reloading `/explore#reselect=…` shows the
public first page until the browser script replaces it with the private listing.

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

For public profile requests, the Worker reads only that ID through api-app's
`POST /discovery/profiles` before rendering the profile.
Published personas remain listed at their five-assignment capacity, without a
capacity badge. Selection enforces capacity; Discovery makes no exclusivity promise
and has no exclusivity section or its images. The Worker validates and strips unknown
fields, renders public content into the initial HTML, and embeds only that public snapshot
for the browser; the browser separately samples the following candidates. No private
persona description, State, Memory, identity sheet or authoring prompt is used.
Profile HTML, sitemap and health responses use `Cache-Control: no-store`.

Home, explorer and profile requests all return the actual application UI in their
first HTML: home has its editorial content, explorer has its first sampled cards,
and profile links have their full public profile. Each profile has a distinct title,
description and canonical URL,
Open Graph and Twitter metadata, and WebPage/CreativeWork JSON-LD that explicitly
identifies a fictional AI persona. Sharing carries the selected `style` and a
`preview=v3` rendition version, so new shares have a fresh identity after the OG
format changes. Open Graph and Twitter advertise a same-origin 1200×630 JPEG at
`/personas/{id}/og/{style}/{photo-id}.v3.jpg`. Its source is the first published
same-style gallery photo: the Worker reads its owned object key directly from
R2, then uses the Images binding to draw a blurred/dimmed backdrop, the uncropped
portrait and a small RenAI watermark in the lower-right corner. Watermark source
is `design/og-watermark.html`; the transparent PNG is `public/og-watermark-v3.png`.
The cherry-rose brand symbol and white wordmark have no surrounding background box.
Bump the rendition version when changing its composition or watermark.

HTML metadata generation does not fetch image bytes. This removes the original
Workers-only failure: `redirect: "error"` was accepted in Node tests but throws
before an outbound Workers request. A renderer failure returns a correlated,
retryable 503; it never silently replaces a published persona preview with brand
artwork. Home/explorer and genuinely absent same-style photos use `social-{locale}-v3.png`.
These 1200×630 previews pair Jia's existing anime/photo editorial portraits with
localized headlines, the RenAI logo and an illustrative-image label.
Open Graph includes image MIME type, width, height, secure URL and alt text;
Twitter uses the large-image card and explicit image/title/description/alt fields.
Style variants share one canonical
URL for search indexing. Without an explicit style query, the server starts in
anime and the browser restores a saved preference. Public writing stays in its
authored language; controls support Korean, English and Japanese.
Each language has its own canonical URL, localized title/description/image alt,
`html lang`, `Content-Language`, OG locale and JSON-LD `inLanguage`. Reciprocal
`hreflang` links include all three languages and `x-default`; missing profiles
have no language alternates. Browser language/profile/style changes refresh the
same metadata and structured data without leaking invitation or reselection fragments.

`/sitemap.xml` lists all three language variants of home, explorer and current
public profile URLs, with reciprocal XHTML language alternates and public image
locations. It never lists a separate directory or withdrawn personas.
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
Discovery → api-app /discovery/personas?locale=…&cursor=… → indexed public candidates
Discovery → api-app /discovery/profiles → requested public IDs only
Discovery → api-app /discovery/waitlist → application Durable Object
```

api-app serves the public Catalog from its persisted snapshot without waiting for
Admin. Admin's change notification invalidates and promptly reloads it, and bounded
maintenance checks it at most once per five minutes while the application is awake for work (see the
[api-app freshness notes](../api/ops/README.md#public-catalog-freshness)).
Server-rendered profiles and the explorer's first page request it with
`cache: no-store`; later pages use the existing browser client, so visits see
profiles without a frontend rebuild. The public snapshot retains the original
R2 image URLs. Private persona descriptions, State and Memory never enter the
public response.

### Sampling and continuation

`GET /discovery/personas` requires `locale` (`ko`, `en`, `ja`) and accepts an
opaque `cursor`. It returns `{ people, nextCursor }`, with at most ten people;
`nextCursor: null` means the candidate set is exhausted. Responses are `no-store`.
The private `POST /discovery/reselection/personas` accepts the same fields plus
the body-only reselection token and excludes ended relationships on every page.

Candidates whose primary language matches the UI come first, followed by those
whose initial public proficiency is proficient/fluent, then everyone else. Each
tier uses a hash-ordered ring with a random starting key, persisted in the cursor.
Keyset continuation wraps each tier once, avoiding duplicate IDs and full-table
random sorts. This is randomized rotation, not a fresh independent shuffle on
every page. Language changes start a new traversal and retain Like/Pass choices
and the mounted contact form. Authored public writing is never translated.

Membership and language ordering use a shared immutable metadata snapshot, not
a per-visitor copy. Cursors expire after one hour; an expired cursor starts a new
sample while preserving choices. New publications join the next traversal;
withdrawn profiles disappear from existing traversals, and profile writing/photos
come from the current publication. Catalog refresh reconciles live rows without
rewriting unchanged profiles. Snapshot reclamation uses indexed, limited batches.

`POST /discovery/profiles` accepts `{ ids, reselectionToken? }` (at most 100 IDs).
Likes are restored by ID, even when absent from the sampled page. Pass/Like records
filter the deck in the browser; loading a page containing previously chosen IDs
continues to subsequent pages as needed. Retried pages are merged by ID.
`GET /discovery/persona-links` supplies only IDs and image URLs for the sitemap.

## Browsing images

Browsing loads each photo's stored display rendition from `persona-images.renai.im`
(`thumbnails/<uuid>.jpg`, a 640px JPEG that Admin writes before every original),
without a Discovery image proxy or request-time resizing/re-encoding. Originals
average about 1.9 MB (mostly 1024px PNGs); renditions average about 115 KB. Cards,
expanded profiles, Likes, the contact list and style preparation all use the
rendition; OG previews and the sitemap keep the original. Photos outside the
owned bucket are shown unchanged. The current card and expanded profile have high
fetch priority, and the server-rendered first card is preloaded. The next card
loads at low priority; Like thumbnails are lazy-loaded.

Home preloads only the selected hero portrait at high priority; the other two load
at low priority. Content-hashed `/assets/*` are served with
`Cache-Control: public, max-age=31536000, immutable` from `public/_headers`.

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
`TURNSTILE_SITE_KEY` repository variable. Before deployment, `check:worker` runs
the built pages through the local Cloudflare runtime and real `ASSETS` binding.
It checks GET/HEAD responses, localized HTML and headers for `/`, `/ko`, `/ja`
and `/explore`, using an isolated local Catalog on an OS-allocated port. This
check also runs in the PR quality gates, requires no Cloudflare credentials and
fails on runtime-only errors before production is changed.
CI then deploys the static assets and checks
`https://renai.im/`, `/ko`, `/ja`, localized explorer pages, localized social PNGs,
`/sitemap.xml` and the exact artifact identity at
`/health`. api-app's deployment checks `/discovery/personas` separately.
`check:preview` then reads a published profile in each available style and fetches
the exact advertised image, requiring a public JPEG, 1200×630 dimensions and less
than 5 MB. It rejects the former brand-image substitution; empty public Catalogs
are reported explicitly. The Worker accepts source photos up to the Images
binding's 20 MB input limit and returns bounded, fixed-size JPEG renditions.
Do not deploy manually or also connect Workers Builds.

`bun run build` builds browser assets and prerenders home into `index.html`; the Worker
negotiates the root locale and serves the English asset without rendering it again.
Wrangler bundles `worker/entry.ts`
and serves `dist/client/` assets. The explorer, public profile routes, sitemap, robots
and health run the Worker first. Explorer and profiles render into the unmodified
application shell, `template.html`, so the first explorer response includes sampled cards.
CI embeds `GITHUB_SHA` through Wrangler's `BUILD_REVISION` define.
`wrangler.jsonc` binds `renai.im` as a custom domain.
`www.renai.im` is a zone redirect. The api-app API permits `https://renai.im`
and verifies waiting registrations with the matching Turnstile secret.
Never put a private token in a `VITE_` key.

For a local packaging check, run `bun run build` and
`bun run check:worker` from this directory.
