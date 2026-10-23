import { discoveryNotices, type DiscoveryNotices } from "@ren-ai/onboarding";
import { useCopy, useLocale } from "./locale.tsx";

export function PrivacyDisclosure({ notices = discoveryNotices }: { notices?: DiscoveryNotices }) {
  const copy = useCopy();
  const notice = notices[useLocale().locale];
  return (
    <details className="privacy-disclosure" id="privacy">
      <summary>{copy.privacy}</summary>
      <h3>{notice.title}</h3>
      <p className="notice-version">{notice.version}</p>
      {notice.sections.map((section) => (
        <section key={section.title}>
          <h4>{section.title}</h4>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </section>
      ))}
    </details>
  );
}
