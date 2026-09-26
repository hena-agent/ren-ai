# Probe: a static TanStack Start site under this repo's toolchain

Run on 2026-09-26 for [The site's code under the gates](https://github.com/hena-agent/ren-ai/issues/22).

**Question:** can a TanStack Start site that is prerendered to static files be built, typechecked, tested and mutated with the versions this repo pins: TypeScript 7.0.2, Vitest 5.0.1 with V8 coverage, and Stryker 10.0.0?

## Verdict

Yes, for a minimal React app with two routes, `/` and `/privacy`. It ran on macOS arm64 with Bun 1.4.2 and Node 24.15.0.

- **Build.** `vite build` with `prerender: { enabled: true, failOnError: true }` wrote `dist/client/index.html`, `dist/client/privacy/index.html` and `dist/client/assets/`. It also wrote `dist/server/server.js`, which the build uses only to prerender. Serving needs only `dist/client`.
- **Typecheck.** `tsc --noEmit` from TypeScript 7.0.2 passed against TanStack Router's types. No TanStack or Vite build module imports the `typescript` compiler API, which TypeScript 7.0.2 doesn't ship.
- **Tests.** A React Testing Library test rendered `/` through `RouterProvider` with a memory history, on Vitest 5.0.1 and happy-dom 20.14.5. V8 coverage reported 100% for the route file.
- **Mutation.** Stryker 10.0.0 instrumented the `.tsx` route through its Vitest runner: three mutants, two killed. The survivor was the route's path, `createFileRoute('/')` changed to `createFileRoute("")`.
- **Versions.** Start needs `vite >=7.0.0`, and Vitest 5.0.1 accepts `^6.4.0 || ^7.0.0 || ^8.0.0`. The probe used Vite 7.3.6.

## Side effects to know

- **The generated route file.** The build writes `src/routeTree.gen.ts`, but `vitest run` doesn't. With the file removed, the test failed with `Failed to resolve import "../src/routeTree.gen" from "tests/index.test.tsx"`.
- **What's in it.** It opens with `/* eslint-disable */` and `// @ts-nocheck`, and casts each route's options with `as any`.
- **`eslint-disable` silences oxlint.** Checked against this repo's `.oxlintrc.json`: `export const loose = (v: any): any => v;` reported 2 errors on its own, and 0 under `/* eslint-disable */`. `bun run exceptions` doesn't report `eslint-disable` or `@ts-nocheck`.
- **The path mutant can't be killed.** The generated file passes each route's `id` and `path` to `.update()` at runtime, so the string in `createFileRoute(...)` only feeds the types and the generator.
- **Test files inside `src/routes`** are treated as routes. The probe warned about `index.test.tsx` until the test moved to `tests/`.
- **The root route renders `<html>`,** so rendering it inside React Testing Library's `<div>` logs a nesting warning. Test pages on their own.

## Files

The probe's files, reformatted for reading. It ran with `bun install`, then `bun run build`, `bun run typecheck`, `bun run test`, and `stryker run`.

`package.json`:

```json
{
  "name": "tanstack-start-static-probe",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --coverage"
  },
  "dependencies": {
    "@tanstack/react-start": "1.168.58",
    "@tanstack/react-router": "1.170.39",
    "react": "19.2.4",
    "react-dom": "19.2.4"
  },
  "devDependencies": {
    "@stryker-mutator/core": "10.0.0",
    "@stryker-mutator/vitest-runner": "10.0.0",
    "@testing-library/react": "16.3.0",
    "@types/react": "19.2.14",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "5.2.0",
    "@vitest/coverage-v8": "5.0.1",
    "happy-dom": "20.14.5",
    "typescript": "7.0.2",
    "vite": "7.3.6",
    "vitest": "5.0.1"
  }
}
```

`vite.config.ts`:

```ts
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [tanstackStart({ prerender: { enabled: true, failOnError: true } }), viteReact()],
});
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "happy-dom",
    coverage: { provider: "v8", include: ["src/routes/index.tsx"], reporter: ["text"] },
  },
});
```

`stryker.config.mjs`:

```js
export default {
  testRunner: "vitest",
  plugins: ["./node_modules/@stryker-mutator/vitest-runner/dist/src/index.js"],
  tsconfigFile: "tsconfig.stryker-disabled.json",
  coverageAnalysis: "off",
  mutate: ["src/routes/index.tsx"],
  thresholds: { high: 0, low: 0, break: 0 },
  reporters: ["clear-text"],
};
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "types": ["vite/client", "vitest/globals"],
    "allowImportingTsExtensions": true
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"]
}
```

`src/router.tsx`:

```tsx
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
export function getRouter() {
  return createRouter({ routeTree });
}
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
```

`src/routes/__root.tsx`:

```tsx
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
export const Route = createRootRoute({ component: Root });
function Root() {
  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
```

`src/routes/index.tsx`:

```tsx
import { Link, createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/")({ component: Home });
export function Home() {
  return (
    <main>
      <h1>Home</h1>
      <Link to="/privacy">Privacy</Link>
    </main>
  );
}
```

`src/routes/privacy.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/privacy")({ component: Privacy });
function Privacy() {
  return (
    <main>
      <h1>Privacy</h1>
    </main>
  );
}
```

`tests/index.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { createMemoryHistory, RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "../src/routeTree.gen";
import { it, expect } from "vitest";
it("renders home via in-memory router", async () => {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
});
```

The start of the generated `src/routeTree.gen.ts`:

```ts
/* eslint-disable */

// @ts-nocheck

// noinspection JSUnusedGlobalSymbols

// This file was automatically generated by TanStack Router.
// You should NOT make any changes in this file as it will be overwritten.
// Additionally, you should also exclude this file from your linter and/or formatter to prevent it from being checked or modified.

import { Route as rootRouteImport } from "./routes/__root";
import { Route as IndexRouteImport } from "./routes/index";
import { Route as PrivacyRouteImport } from "./routes/privacy";

const IndexRoute = IndexRouteImport.update({
  id: "/",
  path: "/",
  getParentRoute: () => rootRouteImport,
} as any);
const PrivacyRoute = PrivacyRouteImport.update({
  id: "/privacy",
  path: "/privacy",
  getParentRoute: () => rootRouteImport,
} as any);
```

## Sources

- [Static prerendering](https://tanstack.com/start/latest/docs/framework/react/guide/static-prerendering) and [SPA mode](https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode) in TanStack Start
- [Start routing](https://tanstack.com/start/latest/docs/framework/react/guide/routing), the Router [FAQ](https://tanstack.com/router/latest/docs/faq) on committing the generated file, and the [file-based routing options](https://tanstack.com/router/latest/docs/api/file-based-routing)
- Package metadata for [`@tanstack/react-start@1.168.58`](https://registry.npmjs.org/@tanstack/react-start/1.168.58) and [`vitest@5.0.1`](https://registry.npmjs.org/vitest/5.0.1)
- Cloudflare: [static site generation on Workers static assets](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/)
- Stryker's [string mutator](https://github.com/stryker-mutator/stryker-js/blob/master/packages/instrumenter/src/mutators/string-literal-mutator.ts), which skips strings in JSX attributes
