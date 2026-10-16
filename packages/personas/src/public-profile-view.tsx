import type { ReactElement } from "react";
import type { PublicProfile } from "./public-profile.ts";

function SectionContent({ section }: { section: PublicProfile["sections"][number] }) {
  switch (section.type) {
    case "interests":
      return (
        <ul>
          {section.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      );
    case "basics":
    case "lifestyle":
    case "relationship":
      return (
        <dl className="profile-facts">
          {section.items.map((item, index) => (
            <div key={index}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      );
    case "prompt":
      return <p>{section.answer}</p>;
  }
  return <p>{section.body}</p>;
}

export function PublicProfileView({ profile }: { profile: PublicProfile }): ReactElement {
  return (
    <div className="public-profile-sections">
      <p>{profile.introduction}</p>
      {profile.sections.map((section, index) => (
        <section className={`public-profile-section profile-${section.type}`} key={index}>
          <h3>{section.type === "prompt" ? section.question : section.title}</h3>
          <SectionContent section={section} />
        </section>
      ))}
    </div>
  );
}
