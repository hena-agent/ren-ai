import { copy } from "../copy.ts";

export function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6 py-12 text-slate-900">
      <h1 className="text-4xl font-bold tracking-tight">{copy.home.title}</h1>
      <p className="text-lg leading-relaxed">{copy.home.description}</p>
      <p className="rounded-xl bg-slate-100 p-4">{copy.home.status}</p>
      <a className="w-fit underline underline-offset-4" href="/privacy">
        {copy.home.privacyLink}
      </a>
    </main>
  );
}
