// @vitest-environment node
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { staticPages } from "./prerender.ts";

test("home and the explorer prerender complete public HTML, and persona pages keep the bare shell", async () => {
  const template = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const pages = await staticPages(template);
  const home = pages["index.html"];
  expect(home).toContain("일상에,");
  expect(home).toContain('class="home-hero"');
  expect(home).toContain('<link rel="canonical" href="https://renai.im/"');
  expect(home).toContain('property="og:image" content="https://renai.im/social.png"');
  expect(home).not.toContain('id="public-personas"');
  const explore = pages["explore.html"];
  expect(explore).toContain('class="discovery-shell"');
  expect(explore).toContain("만날 사람들을 불러오고 있어요.");
  expect(explore).not.toContain('class="profile-card"');
  expect(explore).not.toContain('id="public-personas"');
  expect(explore).not.toContain('href="/personas"');
  expect(explore).toContain('name="robots" content="index,follow,max-image-preview:large"');
  expect(explore).toContain('<link rel="canonical" href="https://renai.im/explore"');
  expect(pages["template.html"]).toBe(template);
});
