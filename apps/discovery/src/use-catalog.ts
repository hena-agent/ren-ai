import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicPersona } from "@ren-ai/onboarding";
import type { DiscoveryClient } from "./client.ts";

type Catalog =
  | { phase: "loading" }
  | { phase: "failed" }
  | { phase: "ready"; people: readonly PublicPersona[] };

export function useCatalog(
  client: DiscoveryClient,
  initialPeople?: readonly PublicPersona[],
  reselectionToken?: string,
) {
  const [catalog, setCatalog] = useState<Catalog>(
    initialPeople ? { phase: "ready", people: initialPeople } : { phase: "loading" },
  );
  const activeRequest = useRef(new AbortController());
  const load = useCallback(
    (controller: AbortController) => {
      void client
        .profiles(controller.signal, reselectionToken)
        .then((people) => {
          if (!controller.signal.aborted) setCatalog({ phase: "ready", people });
          return undefined;
        })
        .catch(() => {
          if (!controller.signal.aborted) setCatalog({ phase: "failed" });
        });
    },
    [client, reselectionToken],
  );
  useEffect(() => {
    if (!initialPeople) {
      const controller = new AbortController();
      activeRequest.current = controller;
      load(controller);
    }
    return () => activeRequest.current.abort();
  }, [load, initialPeople]);
  function retry() {
    activeRequest.current.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setCatalog({ phase: "loading" });
    load(controller);
  }
  async function refresh() {
    activeRequest.current.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const people = await client.profiles(controller.signal, reselectionToken);
    if (!controller.signal.aborted) setCatalog({ phase: "ready", people });
  }
  return { catalog, retry, refresh };
}
