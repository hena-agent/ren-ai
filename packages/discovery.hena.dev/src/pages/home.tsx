import { useEffect, useState } from "react";
import { copy } from "../copy.ts";
import type { OnboardingClient } from "../onboarding-client.ts";
import { OnboardingForm } from "./onboarding-form.tsx";

export function Home({ onboarding }: { onboarding: OnboardingClient }) {
  const [selected, setSelected] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const reload = () => {
    setSelected(undefined);
    setRevision((value) => value + 1);
  };
  if (selected)
    return (
      <>
        <button className="m-6 underline" onClick={() => setSelected(undefined)}>
          {copy.catalog.change}
        </button>
        <OnboardingForm
          onboarding={onboarding}
          personaID={selected}
          onUnavailable={() => {
            setUnavailable(true);
            reload();
          }}
        />
      </>
    );
  return (
    <Catalog
      key={revision}
      onboarding={onboarding}
      unavailable={unavailable}
      onRetry={reload}
      onSelect={(id) => {
        setUnavailable(false);
        setSelected(id);
      }}
    />
  );
}

function Catalog({
  onboarding,
  unavailable,
  onRetry,
  onSelect,
}: {
  onboarding: OnboardingClient;
  unavailable: boolean;
  onRetry: () => void;
  onSelect: (id: string) => void;
}) {
  const [catalog, setCatalog] = useState<{
    personas: Awaited<ReturnType<OnboardingClient["catalog"]>>;
  }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const list = await onboarding.catalog();
        if (active) setCatalog({ personas: list });
      } catch {
        if (active) setFailed(true);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [onboarding]);
  const personas = catalog?.personas;
  if (catalog && personas === undefined)
    return <OnboardingForm onboarding={onboarding} onUnavailable={onRetry} />;
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 px-6 py-12 text-slate-900">
      <h1 className="text-4xl font-bold">{copy.home.title}</h1>
      <p>{copy.home.description}</p>
      <h2 className="text-2xl">{copy.catalog.title}</h2>
      {unavailable && <p role="alert">{copy.answers.persona_unavailable}</p>}
      {failed ? (
        <div role="alert">
          {copy.catalog.failure} <button onClick={onRetry}>{copy.catalog.retry}</button>
        </div>
      ) : personas ? (
        personas.length ? (
          <ul className="flex flex-col gap-4">
            {personas.map((persona) => (
              <li key={persona.id}>
                <button
                  className="w-full rounded-xl border p-6 text-left hover:bg-slate-50 focus-visible:outline-2"
                  onClick={() => onSelect(persona.id)}
                >
                  {persona.imageUrl && (
                    <img
                      className="mb-3 h-32 w-32 rounded-full object-cover"
                      src={persona.imageUrl}
                      alt=""
                    />
                  )}
                  <strong className="text-xl">{persona.name}</strong>
                  <p>{persona.bio}</p>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>{copy.catalog.empty}</p>
        )
      ) : (
        <output>{copy.catalog.loading}</output>
      )}
      <a href="/privacy" className="underline">
        {copy.home.privacyLink}
      </a>
    </main>
  );
}
