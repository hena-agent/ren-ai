import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import "../styles.css";

export const Route = createRootRoute({ component: Root });

function Root() {
  return (
    <html lang="ko">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
