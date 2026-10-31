import { App } from "./app.tsx";
import type { DiscoveryClient } from "./client.ts";
import { discoveryClient } from "./client.ts";
import { About } from "./about.tsx";
import { LocaleProvider } from "./locale.tsx";
import { localizedPath, publicRoute, readPublicBootstrap } from "./public-routing.ts";

export function Site({ client = discoveryClient }: { client?: DiscoveryClient }) {
  const route = publicRoute(new URL(window.location.href));
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (route.id || route.path === "/explore" || fragment.has("reselect")) {
    // A private Reselection listing never starts from the public server-rendered people.
    const bootstrap = fragment.has("reselect")
      ? undefined
      : readPublicBootstrap(document.getElementById("public-personas")?.textContent ?? null);
    return (
      <App
        client={client}
        initialLocale={route.locale ?? bootstrap?.page?.locale ?? "en"}
        personaId={route.id}
        initialStyle={route.style}
        reselectionToken={fragment.get("reselect") ?? undefined}
        initialPeople={bootstrap?.people}
        initialPage={bootstrap?.page}
      />
    );
  }
  if (route.path !== "/about")
    return (
      <main>
        <h1>404 — RenAI</h1>
        <a href={localizedPath("/explore", route.locale ?? "en")}>RenAI</a>
      </main>
    );
  return (
    <LocaleProvider initialLocale={route.locale ?? "en"}>
      <About client={client} />
    </LocaleProvider>
  );
}
