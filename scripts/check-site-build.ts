import { readFileSync } from "node:fs";
import ko from "../packages/onboarding/src/locales/ko.json" with { type: "json" };

for (const [path, title] of [
  ["dist/client/index.html", ko.home.title],
  ["dist/client/privacy/index.html", ko.privacy.title],
] as const) {
  const html = readFileSync(path, "utf8");
  if (
    !/<html[^>]*lang="ko"/.test(html) ||
    !html.includes("<main") ||
    !html.includes(title) ||
    !html.includes("</html>")
  ) {
    throw new Error(`Missing Korean prerendered page: ${path}`);
  }
}
