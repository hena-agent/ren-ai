import { App } from "./app.tsx";
import type { DiscoveryClient } from "./client.ts";
import { discoveryClient } from "./client.ts";
import { Home } from "./home.tsx";
import { LocaleProvider } from "./locale.tsx";

export function Site({ client = discoveryClient }: { client?: DiscoveryClient }) {
  // Reselection links sent through iMessage open Discovery with their private fragment intact.
  const reselecting = new URLSearchParams(window.location.hash.slice(1)).has("reselect");
  if (window.location.pathname === "/explore" || reselecting) return <App client={client} />;
  return (
    <LocaleProvider>
      <Home />
    </LocaleProvider>
  );
}
