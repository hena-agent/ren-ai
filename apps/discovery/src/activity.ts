import { useCallback, useEffect } from "react";
import { Schema } from "effect";
import { BrowserStep, VisitSource, type Activity } from "@ren-ai/onboarding";
import type { DiscoveryClient } from "./client.ts";
import { useLocale } from "./locale.tsx";
import type { ImageStyle } from "./image-style.ts";
import { languageRoute } from "./public-routing.ts";

const visitKey = "ren-ai.visit";
const optOutKey = "ren-ai.metrics.off";
const Visit = Schema.Struct({
  started: Schema.Number,
  last: Schema.Number,
  source: VisitSource,
  country: Schema.optionalKey(Schema.String),
  steps: Schema.Array(Schema.String),
});
const idle = 30 * 60_000;
const tag = (value: string | null) => (value ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 80);

function enabled() {
  const url = new URL(window.location.href);
  if (url.searchParams.get("metrics") === "off") {
    localStorage.setItem(optOutKey, "1");
    sessionStorage.removeItem(visitKey);
    url.searchParams.delete("metrics");
    window.history.replaceState(window.history.state, "", url);
  }
  return localStorage.getItem(optOutKey) !== "1";
}
function visit() {
  const saved = sessionStorage.getItem(visitKey);
  const now = Date.now();
  if (saved) {
    const previous = Schema.decodeUnknownSync(Schema.fromJsonString(Visit))(saved);
    if (now >= previous.last && now - previous.last < idle)
      return { ...previous, last: now, steps: [...previous.steps] };
  }
  const url = new URL(window.location.href);
  const referrer = URL.canParse(document.referrer) ? new URL(document.referrer) : undefined;
  const { path } = languageRoute(url.pathname);
  const source: VisitSource = {
    entry: new URLSearchParams(url.hash.slice(1)).has("reselect")
      ? "reselection"
      : path.startsWith("/personas/")
        ? "profile"
        : path === "/explore"
          ? "explore"
          : "home",
    referrer: referrer && referrer.host !== url.host ? referrer.hostname : "",
    source: tag(url.searchParams.get("utm_source")),
    medium: tag(url.searchParams.get("utm_medium")),
    campaign: tag(url.searchParams.get("utm_campaign")),
  };
  return { started: now, last: now, source, country: undefined, steps: [] as string[] };
}
export function visitContext() {
  try {
    if (!enabled()) return {};
    const current = visit();
    return { source: current.source, ...(current.country && { visitCountry: current.country }) };
  } catch {
    return {};
  }
}

export function useActivity(
  client: DiscoveryClient,
  imageStyle: ImageStyle,
  explore = false,
  context: { seen?: string | undefined; opened?: string | undefined; joining?: boolean } = {},
) {
  const { locale } = useLocale();
  const { seen, opened, joining } = context;
  const report = useCallback(
    (step: typeof BrowserStep.Type, persona?: string) => {
      try {
        if (!enabled()) return;
        const current = visit();
        const send = (next: typeof BrowserStep.Type, id?: string) => {
          const key = `${next}:${next === "first_like" ? "" : (id ?? "")}`;
          if (current.steps.includes(key)) return;
          current.steps.push(key);
          const activity: Activity = {
            step: next,
            source: current.source,
            locale,
            imageStyle,
            device: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "phone" : "computer",
            ...(id && { persona: id }),
            ...(current.country && { visitCountry: current.country }),
          };
          void client
            .activity(activity)
            .then((country) => {
              if (next !== "visit" || !country || !/^[A-Z]{2}$/.test(country) || !enabled())
                return undefined;
              const latest = visit();
              if (latest.started === current.started)
                sessionStorage.setItem(visitKey, JSON.stringify({ ...latest, country }));
              return undefined;
            })
            .catch(() => {});
        };
        send("visit");
        if (explore) send("explore");
        if (seen) send("profile_seen", seen);
        if (opened) send("profile_opened", opened);
        if (joining) send("join_opened");
        send(step, persona);
        if (step === "like") send("first_like", persona);
        sessionStorage.setItem(visitKey, JSON.stringify(current));
      } catch {
        /* Counting never interrupts browsing, including blocked browser storage. */
      }
    },
    [client, locale, imageStyle, explore, seen, opened, joining],
  );
  useEffect(() => {
    const active = () => report("visit");
    active();
    for (const event of ["pointerdown", "keydown", "scroll"])
      document.addEventListener(event, active, { passive: true });
    return () => {
      for (const event of ["pointerdown", "keydown", "scroll"])
        document.removeEventListener(event, active);
    };
  }, [report]);
  return report;
}

export function useBrowseActivity(
  client: DiscoveryClient,
  style: ImageStyle,
  current: string | undefined,
  detail: string | undefined,
  view: string,
) {
  return useActivity(client, style, true, {
    seen: view !== "contact" ? (detail ?? current) : undefined,
    opened: detail,
    joining: view === "contact",
  });
}
