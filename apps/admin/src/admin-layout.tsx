import type { ReactNode } from "react";
import copy from "./copy.json";

/** Content-hashed browser asset paths, defined by `scripts/build.mjs` and Vitest. */
declare const ADMIN_ASSETS: { script: string; stylesheet: string };

const groups = [
  {
    label: "페르소나 관리",
    links: [
      ["personas", "/", copy.list],
      ["new", "/new", `+ ${copy.new}`],
      ["seeding", "/seeding", "시딩"],
    ],
  },
  {
    label: "서비스 운영",
    links: [
      ["waitlist", "/waitlist", "대기자"],
      ["first-contacts", "/first-contacts", "첫 연락"],
      ["conversations", "/conversations", "대화 상태"],
      ["invitations", "/invitations", "초대장"],
      ["social", "/social", "소셜 활동"],
      ["metrics", "/metrics", "지표"],
    ],
  },
] as const;

type Section = (typeof groups)[number]["links"][number][0];

export function AdminLayout({
  active,
  title = copy.title,
  recoveryAvailable,
  children,
}: {
  active: Section;
  title?: string;
  recoveryAvailable?: boolean;
  children: ReactNode;
}) {
  return (
    <html lang="ko">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="icon" type="image/svg+xml" href="/brand.svg" />
        <link rel="stylesheet" href={ADMIN_ASSETS.stylesheet} />
        <script src={ADMIN_ASSETS.script} type="module" />
      </head>
      <body className="admin-layout">
        <a className="skip-link" href="#main">
          {copy.skip}
        </a>
        <header className="admin-sidebar">
          <a className="brand" href="/">
            {copy.brand}
          </a>
          <details className="admin-menu" open>
            <summary>{copy.navigation}</summary>
            <nav aria-label={copy.navigation}>
              {groups.map((group) => (
                <div className="admin-nav-group" key={group.label}>
                  <p>{group.label}</p>
                  {group.links.map(([id, href, label]) => (
                    <a href={href} aria-current={active === id ? "page" : undefined} key={id}>
                      {label}
                    </a>
                  ))}
                </div>
              ))}
              {recoveryAvailable && (
                <a className="admin-recovery" href="/editing-recovery">
                  편집 기록 복구 파일
                </a>
              )}
            </nav>
          </details>
        </header>
        {children}
      </body>
    </html>
  );
}
