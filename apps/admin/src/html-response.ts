import { randomUUID } from "node:crypto";

export function html(page: string, status = 200) {
  const nonce = randomUUID();
  return new Response(
    page.replace("</head>", `<meta name="style-nonce" content="${nonce}"></head>`),
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'self' 'nonce-${nonce}'; script-src 'self'; connect-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      },
    },
  );
}
