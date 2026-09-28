import { copy } from "../copy.ts";

export function Privacy() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-12 text-slate-900">
      <h1 className="text-4xl font-bold tracking-tight">{copy.privacy.title}</h1>
      <p>{copy.privacyNoticeVersion}</p>
      {copy.privacy.intro.map((paragraph) => (
        <p key={paragraph} className="leading-relaxed">
          {paragraph}
        </p>
      ))}
      {copy.privacy.sections.map((section) => (
        <section key={section.title} className="flex flex-col gap-3">
          <h2 className="text-2xl font-semibold">{section.title}</h2>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph} className="leading-relaxed">
              {paragraph}
            </p>
          ))}
        </section>
      ))}
      <section className="flex flex-col gap-3">
        <h2 className="text-2xl font-semibold">{copy.privacy.contact.title}</h2>
        <a
          className="w-fit underline underline-offset-4"
          href={`mailto:${copy.privacy.contact.email}`}
        >
          {copy.privacy.contact.email}
        </a>
      </section>
      <a className="w-fit underline underline-offset-4" href="/">
        {copy.privacy.homeLink}
      </a>
    </main>
  );
}
