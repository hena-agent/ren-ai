# The discovery registration site is prerendered by TanStack Start

discovery.hena.dev is a TanStack Start app, in React, that Vite prerenders into static files. Cloudflare Workers serves them as static assets with no Worker code, and the browser calls api-msg.hena.dev directly. Libraries are Just-in-Time, and AGENTS.md forbids a library build step, because a library whose compiled output hasn't been built makes type-aware lint and knip pass while checking nothing. Browser applications build JavaScript. They can't cause that failure: nothing imports their build output, `dist/` is ignored by git and by every gate, and every gate runs on their source, `.tsx` files included.

`apps/discovery` is a separate Vite browser application for swipe-based persona discovery and liked-persona registration. It builds from source alongside the TanStack site in CI. Both browser apps need JavaScript; neither build output is imported by another package.

## Considered Options

- **Plain JavaScript files, with no build.** Coverage, duplication and the exceptions report only match TypeScript files, so they would pass while checking nothing. The browser also couldn't import `packages/onboarding`.
- **Pages rendered by a Worker, with no script of ours in the browser.** Tests would be simplest, and the per-IP limit would still see each visitor's IP, because Cloudflare passes it on to a Worker's requests within the same zone. It was rejected because it puts a Worker between the browser and the API. The site stays static files that call the API directly, as fixed while charting.

## Consequences

- The gates widen to `.tsx`, and `verify-gates` proves it with a planted `.tsx` violation. CI builds the site in the gates job.
- The route file TanStack generates, `src/routeTree.gen.ts`, is committed and exempt from source-analysis gates through `quality-exceptions.json`.
- Styling uses Tailwind in plain `className` attributes.
- The copy is JSON, one file per locale, so interface text stays separate from component logic. On static hosting only a script can read the browser's languages, so a second locale gets its own URL prefix.
- The API answers CORS only for discovery.hena.dev. The former msg.hena.dev hostname is retired without a redirect.
- GitHub Actions deploys the site on every push to `main`, while the API is deployed by hand. Changes to `packages/onboarding` keep both discovery clients working while the API is deployed independently. The domain cutover requires deploying the API's new CORS origin first; see the [cutover steps](../../packages/api-msg.hena.dev/ops/README.md#discovery-domain-cutover).
