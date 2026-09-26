# The site is prerendered by TanStack Start, the one package with a build

msg.hena.dev is a TanStack Start app, in React, that Vite prerenders into static files. Cloudflare Workers serves them as static assets with no Worker code, and the browser calls api-msg.hena.dev directly. Every other package is Just-in-Time, and AGENTS.md forbids a build step, because a library whose compiled output hasn't been built makes type-aware lint and knip pass while checking nothing. Browsers can't run TypeScript, so the site is the one exception. It can't cause that failure: nothing imports its build output, `dist/` is ignored by git and by every gate, and every gate runs on the site's source, `.tsx` files included.

## Considered Options

- **Plain JavaScript files, with no build.** Coverage, mutation, duplication and the exceptions report only match TypeScript files, so they would pass while checking nothing. The browser also couldn't import `packages/onboarding`.
- **Pages rendered by a Worker, with no script of ours in the browser.** Tests would be simplest, and the per-IP limit would still see each visitor's IP, because Cloudflare passes it on to a Worker's requests within the same zone. It was rejected because it puts a Worker between the browser and the API. The site stays static files that call the API directly, as fixed while charting.

## Consequences

- The gates widen to `.tsx`, and `verify-gates` proves it with a planted `.tsx` violation. CI builds the site in the gates job.
- The route file TanStack generates, `src/routeTree.gen.ts`, is committed and exempt from every gate through `quality-exceptions.json`. Each route file's path string carries an inline Stryker suppression, because the generated file supplies the path at runtime and no test can catch its mutant.
- Styling uses Tailwind in plain `className` attributes, which Stryker doesn't mutate. shadcn/ui builds its classes with `cn()` and `cva()`, whose strings Stryker does mutate.
- The copy is JSON, one file per locale, so Stryker doesn't mutate the prose. On static hosting only a script can read the browser's languages, so a second locale gets its own URL prefix.
- The API answers CORS for msg.hena.dev.
- GitHub Actions deploys the site on every push to `main`, while the API is deployed by hand. The site therefore always goes live first, and every change to the shapes in `packages/onboarding` must keep the new site working with the API that's still running.
