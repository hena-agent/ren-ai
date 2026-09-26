import { copy } from "../copy.ts";

export function Privacy() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6 py-12 text-slate-900">
      <h1 className="text-4xl font-bold tracking-tight">{copy.privacy.title}</h1>
      <p className="text-lg leading-relaxed">{copy.privacy.placeholder}</p>
      <a className="w-fit underline underline-offset-4" href="/">
        {copy.privacy.homeLink}
      </a>
    </main>
  );
}
