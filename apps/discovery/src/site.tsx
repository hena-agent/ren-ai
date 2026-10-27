import { App } from "./app.tsx";
import type { DiscoveryClient } from "./client.ts";
import { discoveryClient } from "./client.ts";
import { Home } from "./home.tsx";
import { LocaleProvider } from "./locale.tsx";
import { publicRoute, readPublicPeople } from "./public-routing.ts";

export function Site({ client = discoveryClient }: { client?: DiscoveryClient }) {
  const route = publicRoute(new URL(window.location.href));
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (route.id || window.location.pathname === "/explore" || fragment.has("reselect")) {
    return (
      <App
        client={client}
        personaId={route.id}
        initialStyle={route.style}
        reselectionToken={fragment.get("reselect") ?? undefined}
        initialPeople={
          fragment.has("reselect")
            ? undefined
            : readPublicPeople(document.getElementById("public-personas")?.textContent ?? null)
        }
      />
    );
  }
  return (
    <LocaleProvider>
      <Home client={client} />
    </LocaleProvider>
  );
}
