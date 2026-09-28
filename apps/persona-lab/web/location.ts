export type LabLocation = { persona: string; sessionId: string | null };

export const locationFromPath = (pathname: string): LabLocation => {
  const match = /^\/personas\/(harin|jiwoo)(?:\/sessions\/([A-Za-z0-9-]+))?$/.exec(pathname);
  return { persona: match?.[1] ?? "harin", sessionId: match?.[2] ?? null };
};

const pathFor = (persona: string, sessionId: string | null): string =>
  `/personas/${encodeURIComponent(persona)}${sessionId ? `/sessions/${encodeURIComponent(sessionId)}` : ""}`;

export const showLocation = (
  persona: string,
  sessionId: string | null,
  mode: "push" | "replace",
): void => {
  const path = pathFor(persona, sessionId);
  if (window.location.pathname === path) return;
  if (mode === "push") window.history.pushState(null, "", path);
  else window.history.replaceState(null, "", path);
};
