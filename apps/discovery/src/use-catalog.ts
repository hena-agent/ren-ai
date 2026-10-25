import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicPersona } from "@ren-ai/onboarding";
import type { DiscoveryClient } from "./client.ts";
import { BrowseExpiredError } from "./client.ts";
import { readChoices } from "./choices.ts";
import { useLocale } from "./locale.tsx";

type Catalog =
  | { phase: "loading" }
  | { phase: "failed" }
  | { phase: "ready"; people: readonly PublicPersona[] };
const merge = (...groups: readonly (readonly PublicPersona[])[]) => [
  ...new Map(groups.flat().map((person) => [person.id, person])).values(),
];

export function useCatalog(
  client: DiscoveryClient,
  initialPeople?: readonly PublicPersona[],
  reselectionToken?: string,
  personaId?: string,
) {
  const { locale } = useLocale();
  const [catalog, setCatalog] = useState<Catalog>(
    initialPeople ? { phase: "ready", people: initialPeople } : { phase: "loading" },
  );
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const active = useRef(new AbortController());
  const pending = useRef(false);
  const reload = useCallback(async () => {
    active.current.abort();
    const controller = new AbortController();
    active.current = controller;
    pending.current = true;
    setLoadingMore(false);
    setMoreFailed(false);
    setCursor(null);
    if (!initialPeople)
      setCatalog((current) => (current.phase === "ready" ? current : { phase: "loading" }));
    const ids = Object.entries(readChoices())
      .filter(([, liked]) => liked)
      .map(([id]) => id);
    if (personaId && !ids.includes(personaId)) ids.push(personaId);
    try {
      const [page, liked] = await Promise.all([
        client.browse({ locale }, controller.signal, reselectionToken),
        ids.length
          ? client.profiles(controller.signal, reselectionToken, ids)
          : Promise.resolve([]),
      ]);
      if (controller.signal.aborted) return;
      setCatalog({ phase: "ready", people: merge(page.people, liked) });
      setCursor(page.nextCursor);
    } catch {
      if (!controller.signal.aborted) {
        setCatalog((current) => (current.phase === "ready" ? current : { phase: "failed" }));
        setMoreFailed(true);
      }
    } finally {
      if (!controller.signal.aborted) pending.current = false;
    }
  }, [client, initialPeople, reselectionToken, personaId, locale]);
  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => (disposed ? undefined : reload()));
    return () => {
      disposed = true;
      active.current.abort();
    };
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (pending.current || catalog.phase !== "ready") return;
    if (!cursor) {
      await reload();
      return;
    }
    pending.current = true;
    setLoadingMore(true);
    setMoreFailed(false);
    const controller = active.current;
    try {
      const page = await client.browse({ locale, cursor }, controller.signal, reselectionToken);
      if (controller.signal.aborted) return;
      setCatalog({ phase: "ready", people: merge(catalog.people, page.people) });
      setCursor(page.nextCursor);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof BrowseExpiredError) {
          await reload();
          return;
        } else setMoreFailed(true);
      }
    } finally {
      if (!controller.signal.aborted) {
        pending.current = false;
        setLoadingMore(false);
      }
    }
  }, [client, locale, cursor, reselectionToken, reload, catalog]);

  async function refresh() {
    active.current.abort();
    const controller = new AbortController();
    active.current = controller;
    pending.current = true;
    setLoadingMore(false);
    const ids = catalog.phase === "ready" ? catalog.people.map((person) => person.id) : [];
    try {
      const people = await client.profiles(controller.signal, reselectionToken, ids);
      if (!controller.signal.aborted) setCatalog({ phase: "ready", people });
    } finally {
      if (!controller.signal.aborted) pending.current = false;
    }
  }
  return {
    catalog,
    retry: () => void reload(),
    refresh,
    hasMore: cursor !== null || moreFailed,
    loadingMore,
    moreFailed,
    loadMore,
  };
}
